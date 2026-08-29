package signaling

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
	"github.com/rs/zerolog"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	ID      string
	User    *models.User
	Room    *models.Room
	Conn    *websocket.Conn
	Send    chan []byte
	Hub     *Hub
	IsMuted bool
	mu      sync.RWMutex
}

type Hub struct {
	cfg     *config.Config
	log     zerolog.Logger
	rooms   map[string]*models.Room
	clients map[string]*Client
	mu      sync.RWMutex
}

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type JoinMessage struct {
	UserID      string `json:"userId"`
	UserName    string `json:"userName"`
	AvatarColor string `json:"avatarColor"`
	RoomID      string `json:"roomId"`
}

type CreateRoomMessage struct {
	RoomName string `json:"roomName"`
	Password string `json:"password,omitempty"`
	MaxUsers int    `json:"maxUsers,omitempty"`
}

type RoomCreatedMessage struct {
	Room *models.Room `json:"room"`
}

type RoomsListMessage struct {
	Rooms []*models.Room `json:"rooms"`
}

type UserJoinedMessage struct {
	User *models.User `json:"user"`
}

type UserLeftMessage struct {
	UserID string `json:"userId"`
}

type RoomStateMessage struct {
	Users []*models.User `json:"users"`
}

type ErrorMessage struct {
	Message string `json:"message"`
}

type MuteMessage struct {
	IsMuted bool `json:"isMuted"`
}

func NewHub(cfg *config.Config, log zerolog.Logger) *Hub {
	hub := &Hub{
		cfg:     cfg,
		log:     log,
		rooms:   make(map[string]*models.Room),
		clients: make(map[string]*Client),
	}

	// Создаём комнату по умолчанию
	defaultRoom := models.NewRoom("main", cfg.MaxUsers)
	hub.rooms["main"] = defaultRoom

	log.Info().
		Str("room", "main").
		Int("maxUsers", cfg.MaxUsers).
		Msg("Created default room")

	return hub
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to upgrade WebSocket connection")
		return
	}

	h.log.Info().Msg("New WebSocket connection established")

	client := &Client{
		ID:   "client_" + uuid.New().String(),
		Conn: conn,
		Send: make(chan []byte, 1024),
		Hub:  h,
	}

	h.mu.Lock()
	h.clients[client.ID] = client
	h.mu.Unlock()

	go client.writePump()
	go client.readPump()
}

func (c *Client) readPump() {
	defer func() {
		c.Hub.removeClient(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(1024 * 1024)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		messageType, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.Hub.log.Debug().Err(err).Msg("WebSocket read error")
			}
			break
		}

		if messageType == websocket.BinaryMessage {
			c.handleAudioData(message)
		} else if messageType == websocket.TextMessage {
			c.handleMessage(message)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(54 * time.Second)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			if len(message) > 0 && message[0] == '{' {
				c.Conn.WriteMessage(websocket.TextMessage, message)
			} else {
				c.Conn.WriteMessage(websocket.BinaryMessage, message)
			}
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (c *Client) handleMessage(data []byte) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to unmarshal message")
		return
	}

	switch msg.Type {
	case "join":
		var joinMsg JoinMessage
		if err := json.Unmarshal(msg.Payload, &joinMsg); err != nil {
			c.Hub.log.Error().Err(err).Msg("Failed to unmarshal join message")
			return
		}
		c.handleJoin(joinMsg)

	case "create_room":
		var createMsg CreateRoomMessage
		if err := json.Unmarshal(msg.Payload, &createMsg); err != nil {
			c.Hub.log.Error().Err(err).Msg("Failed to unmarshal create room message")
			return
		}
		c.handleCreateRoom(createMsg)

	case "get_rooms":
		c.handleGetRooms()

	case "mute":
		var muteMsg MuteMessage
		if err := json.Unmarshal(msg.Payload, &muteMsg); err != nil {
			c.Hub.log.Error().Err(err).Msg("Failed to unmarshal mute message")
			return
		}
		c.handleMute(muteMsg)

	default:
		c.Hub.log.Debug().Str("type", msg.Type).Msg("Unknown message type")
	}
}

func (c *Client) handleJoin(msg JoinMessage) {
	roomID := msg.RoomID
	if roomID == "" {
		roomID = "main"
	}

	room := c.Hub.getRoom(roomID)
	if room == nil {
		c.sendError("Room not found")
		return
	}

	user := &models.User{
		ID:          msg.UserID,
		Name:        msg.UserName,
		AvatarColor: msg.AvatarColor,
		JoinedAt:    time.Now(),
	}

	if err := room.AddUser(user); err != nil {
		c.sendError("Room is full")
		return
	}

	c.User = user
	c.Room = room

	c.Hub.log.Info().
		Str("userId", user.ID).
		Str("userName", user.Name).
		Str("room", room.Name).
		Msg("User joined room")

	// Отправляем состояние комнаты
	roomState := RoomStateMessage{
		Users: room.GetUsers(),
	}
	c.sendJSON("room_state", roomState)

	// Уведомляем других
	for _, client := range c.Hub.getClientsInRoom(room.ID) {
		if client.ID != c.ID {
			client.sendJSON("user_joined", UserJoinedMessage{User: user})
		}
	}
}

func (c *Client) handleCreateRoom(msg CreateRoomMessage) {
	roomID := generateRoomID(msg.RoomName)

	room := models.NewRoom(msg.RoomName, msg.MaxUsers)
	if room == nil {
		c.sendError("Failed to create room")
		return
	}

	c.Hub.mu.Lock()
	c.Hub.rooms[roomID] = room
	c.Hub.mu.Unlock()

	c.Hub.log.Info().
		Str("roomId", roomID).
		Str("roomName", msg.RoomName).
		Msg("Room created")

	c.sendJSON("room_created", RoomCreatedMessage{Room: room})
}

func (c *Client) handleGetRooms() {
	c.Hub.mu.RLock()
	var rooms []*models.Room
	for _, room := range c.Hub.rooms {
		rooms = append(rooms, room)
	}
	c.Hub.mu.RUnlock()

	c.sendJSON("rooms_list", RoomsListMessage{Rooms: rooms})
}

func (c *Client) handleMute(msg MuteMessage) {
	c.mu.Lock()
	c.IsMuted = msg.IsMuted
	c.mu.Unlock()
}

func (c *Client) handleAudioData(audioData []byte) {
	if c.User == nil || c.Room == nil {
		return
	}

	c.mu.RLock()
	isMuted := c.IsMuted
	c.mu.RUnlock()

	if isMuted {
		return
	}

	for _, client := range c.Hub.getClientsInRoom(c.Room.ID) {
		if client.ID == c.ID {
			continue
		}

		select {
		case client.Send <- audioData:
		default:
		}
	}
}

func (c *Client) sendJSON(msgType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to marshal payload")
		return
	}

	msg := Message{
		Type:    msgType,
		Payload: data,
	}

	msgData, err := json.Marshal(msg)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to marshal message")
		return
	}

	select {
	case c.Send <- msgData:
	default:
		c.Hub.log.Warn().Msg("Client send channel is full")
	}
}

func (c *Client) sendError(message string) {
	c.sendJSON("error", ErrorMessage{Message: message})
}

func (h *Hub) getRoom(roomID string) *models.Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[roomID]
}

func (h *Hub) getClientsInRoom(roomID string) []*Client {
	h.mu.RLock()
	defer h.mu.RUnlock()

	var clients []*Client
	for _, client := range h.clients {
		if client.Room != nil && client.Room.ID == roomID {
			clients = append(clients, client)
		}
	}
	return clients
}

func (h *Hub) removeClient(client *Client) {
	h.log.Info().
		Str("clientId", client.ID).
		Msg("Client disconnected")

	h.mu.Lock()
	delete(h.clients, client.ID)
	h.mu.Unlock()

	if client.Room != nil && client.User != nil {
		client.Room.RemoveUser(client.User.ID)

		for _, c := range h.getClientsInRoom(client.Room.ID) {
			c.sendJSON("user_left", UserLeftMessage{UserID: client.User.ID})
		}

		h.log.Info().
			Str("userId", client.User.ID).
			Str("room", client.Room.Name).
			Int("totalUsers", client.Room.Count()).
			Msg("User left room")
	}
}

func (h *Hub) GetRoomUserCount() int {
	room := h.getRoom("main")
	if room == nil {
		return 0
	}
	return room.Count()
}

func (h *Hub) Close() {
	h.log.Info().Msg("Closing signaling hub")

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		client.Conn.Close()
	}
}

func generateRoomID(roomName string) string {
	return "room_" + uuid.New().String()[:8]
}
