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

	room := models.NewRoom(cfg.RoomName, cfg.MaxUsers)
	hub.rooms[cfg.RoomName] = room

	log.Info().
		Str("room", cfg.RoomName).
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

	c.Conn.SetReadLimit(1024 * 1024) // 1MB max message size
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
			// Бинарные аудио данные
			c.handleAudioData(message)
		} else if messageType == websocket.TextMessage {
			// JSON сообщение
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

			// Определяем тип сообщения
			if len(message) > 0 && message[0] == '{' {
				// JSON сообщение
				c.Conn.WriteMessage(websocket.TextMessage, message)
			} else {
				// Бинарные аудио данные
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
	c.Hub.log.Info().
		Str("userId", msg.UserID).
		Str("userName", msg.UserName).
		Msg("User joining room")

	user := &models.User{
		ID:          msg.UserID,
		Name:        msg.UserName,
		AvatarColor: msg.AvatarColor,
		JoinedAt:    time.Now(),
	}

	room := c.Hub.getRoom()
	if room == nil {
		c.sendError("Room not found")
		return
	}

	if err := room.AddUser(user); err != nil {
		c.sendError("Room is full")
		return
	}

	c.User = user
	c.Room = room

	// Отправляем текущее состояние комнаты
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

	c.Hub.log.Info().
		Str("userId", user.ID).
		Str("room", room.Name).
		Int("totalUsers", room.Count()).
		Msg("User joined room")
}

func (c *Client) handleMute(msg MuteMessage) {
	c.mu.Lock()
	c.IsMuted = msg.IsMuted
	c.mu.Unlock()

	c.Hub.log.Debug().
		Str("userId", c.User.ID).
		Bool("isMuted", msg.IsMuted).
		Msg("User mute state changed")
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

	// Пересылаем аудио всем остальным клиентам в комнате
	for _, client := range c.Hub.getClientsInRoom(c.Room.ID) {
		if client.ID == c.ID {
			continue
		}

		select {
		case client.Send <- audioData:
		default:
			// Буфер полон, пропускаем пакет
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

func (h *Hub) getRoom() *models.Room {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return h.rooms[h.cfg.RoomName]
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
	room := h.getRoom()
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
