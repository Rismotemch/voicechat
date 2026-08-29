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

const (
	// WebSocket тайминги
	writeWait      = 10 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024 // 512 KB
	sendChannelCap = 512        // Емкость канала исходящих сообщений
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  4096,
	WriteBufferSize: 4096,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// =============================================================================
// Client: Сетевая сессия пользователя
// =============================================================================

type Client struct {
	ID          string
	User        *models.User
	Room        *models.Room
	AudioClient *AudioClient
	Conn        *websocket.Conn
	Send        chan []byte
	Hub         *Hub
	closeOnce   sync.Once
	mu          sync.RWMutex
}

func (c *Client) closeSendChannel() {
	c.closeOnce.Do(func() {
		close(c.Send)
	})
}

// =============================================================================
// Hub: Менеджер комнат, маршрутизации и аудио-хабов
// =============================================================================

type Hub struct {
	cfg       *config.Config
	log       zerolog.Logger
	rooms     map[string]*models.Room
	audioHubs map[string]*AudioHub
	clients   map[string]*Client
	mu        sync.RWMutex
}

func NewHub(cfg *config.Config, log zerolog.Logger) *Hub {
	hub := &Hub{
		cfg:       cfg,
		log:       log,
		rooms:     make(map[string]*models.Room),
		audioHubs: make(map[string]*AudioHub),
		clients:   make(map[string]*Client),
	}

	// Инициализация дефолтной комнаты 'main'
	defaultRoom := models.NewRoom("main", cfg.MaxUsers)
	defaultRoom.ID = "main"
	hub.rooms["main"] = defaultRoom
	hub.audioHubs["main"] = NewAudioHub()

	return hub
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Error().Err(err).Msg("WebSocket upgrade failed")
		return
	}

	client := &Client{
		ID:   "client_" + uuid.New().String(),
		Conn: conn,
		Send: make(chan []byte, sendChannelCap),
		Hub:  h,
	}

	h.mu.Lock()
	h.clients[client.ID] = client
	h.mu.Unlock()

	go client.writePump()
	go client.readPump()
}

// =============================================================================
// I/O Pumps (Goroutines)
// =============================================================================

func (c *Client) readPump() {
	defer func() {
		c.Hub.removeClient(c)
		c.Conn.Close()
	}()

	c.Conn.SetReadLimit(maxMessageSize)
	_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
	c.Conn.SetPongHandler(func(string) error {
		_ = c.Conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	for {
		messageType, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.Hub.log.Warn().Err(err).Str("clientId", c.ID).Msg("WebSocket read loop closed unexpectedly")
			}
			break
		}

		switch messageType {
		case websocket.BinaryMessage:
			// Входящий бинарный PCM фрейм от микрофона клиента
			c.handleAudioData(message)
		case websocket.TextMessage:
			// Сигнальное JSON сообщение
			c.handleTextMessage(message)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				// Канал закрыт — отправляем CloseFrame
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			// Детекция типа сообщения:
			// Сигнальный JSON всегда начинается с '{' (0x7B)
			// Аудио-пакет начинается с uint16 big-endian ID length (обычно 0x00)
			if len(message) > 0 && message[0] == '{' {
				if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
					return
				}
			} else {
				if err := c.Conn.WriteMessage(websocket.BinaryMessage, message); err != nil {
					return
				}
			}

		case <-ticker.C:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.Conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// =============================================================================
// Обработка сигнальных сообщений (Signaling)
// =============================================================================

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type JoinMessage struct {
	UserID      string `json:"userId"`
	UserName    string `json:"userName"`
	AvatarColor string `json:"avatarColor"`
	RoomID      string `json:"roomId"`
	Password    string `json:"password,omitempty"`
}

type CreateRoomMessage struct {
	RoomName         string `json:"roomName"`
	Password         string `json:"password,omitempty"`
	MaxUsers         int    `json:"maxUsers,omitempty"`
	CatInBagMode     bool   `json:"catInBagMode,omitempty"`
	SpatialAudioMode bool   `json:"spatialAudioMode,omitempty"`
	HighQualityMode  bool   `json:"highQualityMode,omitempty"`
}

type MuteMessage struct {
	IsMuted bool `json:"isMuted"`
}

type LeaveMessage struct {
	RoomID string `json:"roomId"`
}

type UpdateProfileMessage struct {
	UserName string `json:"userName"`
}

func (c *Client) handleTextMessage(data []byte) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		c.Hub.log.Warn().Err(err).Msg("Invalid JSON message structure")
		return
	}

	switch msg.Type {
	case "join":
		var p JoinMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleJoin(p)
		}
	case "leave":
		var p LeaveMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleLeave(p)
		}
	case "mute":
		var p MuteMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleMute(p)
		}
	case "update_profile":
		var p UpdateProfileMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleUpdateProfile(p)
		}
	case "create_room":
		var p CreateRoomMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleCreateRoom(p)
		}
	case "get_rooms":
		c.handleGetRooms()
	}
}

func (c *Client) handleJoin(msg JoinMessage) {
	roomID := msg.RoomID
	if roomID == "" {
		roomID = "main"
	}

	c.Hub.mu.Lock()
	room, roomExists := c.Hub.rooms[roomID]
	if !roomExists {
		c.Hub.mu.Unlock()
		c.sendError("Комната не найдена")
		return
	}

	if !room.VerifyPassword(msg.Password) {
		c.Hub.mu.Unlock()
		c.sendError("Неверный пароль от комнаты")
		return
	}

	// Проверка лимита участников
	if room.Count() >= room.MaxUsers {
		c.Hub.mu.Unlock()
		c.sendError("Комната заполнена")
		return
	}

	// Извлечение или создание AudioHub для комнаты
	audioHub, aHubExists := c.Hub.audioHubs[roomID]
	if !aHubExists {
		audioHub = NewAudioHub()
		c.Hub.audioHubs[roomID] = audioHub
	}
	c.Hub.mu.Unlock()

	// Удаление из предыдущей комнаты, если клиент уже был в другой
	if c.Room != nil {
		c.handleLeave(LeaveMessage{RoomID: c.Room.ID})
	}

	user := &models.User{
		ID:          msg.UserID,
		Name:        msg.UserName,
		AvatarColor: msg.AvatarColor,
		JoinedAt:    time.Now(),
	}

	if err := room.AddUser(user); err != nil {
		c.sendError("Не удалось войти в комнату")
		return
	}

	// Инициализация AudioClient для DSP-пайплайна
	audioClient := &AudioClient{
		ID:        c.ID,
		UserID:    user.ID,
		Send:      c.Send,
		IsMuted:   false,
		Processor: NewAudioProcessor(),
	}

	audioHub.AddClient(audioClient)

	c.mu.Lock()
	c.User = user
	c.Room = room
	c.AudioClient = audioClient
	c.mu.Unlock()

	// 1. Отправляем текущее состояние комнаты вошедшему пользователю
	c.sendJSON("room_state", map[string]interface{}{
		"users": room.GetUsers(),
	})

	// 2. Оповещаем остальных участников комнаты
	c.Hub.broadcastToRoom(room.ID, "user_joined", map[string]interface{}{
		"user": user,
	}, c.ID)
}

func (c *Client) handleLeave(msg LeaveMessage) {
	c.mu.Lock()
	room := c.Room
	user := c.User
	audioClient := c.AudioClient
	c.Room = nil
	c.User = nil
	c.AudioClient = nil
	c.mu.Unlock()

	if room == nil || user == nil {
		return
	}

	room.RemoveUser(user.ID)

	c.Hub.mu.RLock()
	audioHub := c.Hub.audioHubs[room.ID]
	c.Hub.mu.RUnlock()

	if audioHub != nil && audioClient != nil {
		audioHub.RemoveClient(c.ID)
	}

	c.Hub.broadcastToRoom(room.ID, "user_left", map[string]interface{}{
		"userId": user.ID,
	}, c.ID)
}

func (c *Client) handleMute(msg MuteMessage) {
	c.mu.Lock()
	if c.AudioClient != nil {
		c.AudioClient.SetMute(msg.IsMuted)
	}
	room := c.Room
	user := c.User
	c.mu.Unlock()

	if room != nil && user != nil {
		c.Hub.broadcastToRoom(room.ID, "user_muted", map[string]interface{}{
			"userId":  user.ID,
			"isMuted": msg.IsMuted,
		}, c.ID)
	}
}

func (c *Client) handleUpdateProfile(msg UpdateProfileMessage) {
	c.mu.Lock()
	if c.User != nil && msg.UserName != "" {
		c.User.Name = msg.UserName
	}
	room := c.Room
	user := c.User
	c.mu.Unlock()

	if room != nil && user != nil {
		c.Hub.broadcastToRoom(room.ID, "user_updated", map[string]interface{}{
			"user": user,
		}, "")
	}
}

func (c *Client) handleCreateRoom(msg CreateRoomMessage) {
	c.Hub.mu.Lock()
	for _, room := range c.Hub.rooms {
		if room.Name == msg.RoomName {
			c.Hub.mu.Unlock()
			c.sendError("Комната с таким названием уже существует")
			return
		}
	}

	maxUsers := msg.MaxUsers
	if maxUsers <= 0 || maxUsers > 10 {
		maxUsers = 10
	}

	roomID := "room_" + uuid.New().String()[:8]
	room := models.NewRoom(msg.RoomName, maxUsers)
	room.ID = roomID
	room.Password = msg.Password

	c.Hub.rooms[roomID] = room
	c.Hub.audioHubs[roomID] = NewAudioHub()
	c.Hub.mu.Unlock()

	c.sendJSON("room_created", map[string]interface{}{
		"room": room,
	})
}

func (c *Client) handleGetRooms() {
	c.Hub.mu.RLock()
	rooms := make([]*models.Room, 0, len(c.Hub.rooms))
	for _, room := range c.Hub.rooms {
		rooms = append(rooms, room)
	}
	c.Hub.mu.RUnlock()

	c.sendJSON("rooms_list", map[string]interface{}{
		"rooms": rooms,
	})
}

// =============================================================================
// Обработка входящего аудио (DSP Relay)
// =============================================================================

func (c *Client) handleAudioData(audioData []byte) {
	c.mu.RLock()
	room := c.Room
	audioClient := c.AudioClient
	c.mu.RUnlock()

	if room == nil || audioClient == nil {
		return
	}

	c.Hub.mu.RLock()
	audioHub := c.Hub.audioHubs[room.ID]
	c.Hub.mu.RUnlock()

	if audioHub != nil {
		// Запуск серверной цепочки DSP (High-Pass, VAD, AGC) и рассылки
		audioHub.ProcessAndBroadcast(c.ID, audioData)
	}
}

// =============================================================================
// Вспомогательные методы отправки и широковещания
// =============================================================================

// GetRoomUserCount возвращает общее количество активных WebSocket-сессий на сервере
func (h *Hub) GetRoomUserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}

func (c *Client) sendJSON(msgType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	msg, err := json.Marshal(Message{Type: msgType, Payload: data})
	if err != nil {
		return
	}

	select {
	case c.Send <- msg:
	default:
		// Дроп события, если очередь сокета переполнена
	}
}

func (c *Client) sendError(message string) {
	c.sendJSON("error", map[string]string{"message": message})
}

func (h *Hub) broadcastToRoom(roomID, msgType string, payload interface{}, excludeClientID string) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	msg, err := json.Marshal(Message{Type: msgType, Payload: data})
	if err != nil {
		return
	}

	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		client.mu.RLock()
		inTargetRoom := client.Room != nil && client.Room.ID == roomID
		client.mu.RUnlock()

		if inTargetRoom && client.ID != excludeClientID {
			select {
			case client.Send <- msg:
			default:
			}
		}
	}
}

func (h *Hub) removeClient(client *Client) {
	h.mu.Lock()
	delete(h.clients, client.ID)
	h.mu.Unlock()

	client.closeSendChannel()

	client.mu.RLock()
	room := client.Room
	user := client.User
	client.mu.RUnlock()

	if room != nil && user != nil {
		room.RemoveUser(user.ID)

		h.mu.RLock()
		audioHub := h.audioHubs[room.ID]
		h.mu.RUnlock()

		if audioHub != nil {
			audioHub.RemoveClient(client.ID)
		}

		h.broadcastToRoom(room.ID, "user_left", map[string]interface{}{
			"userId": user.ID,
		}, client.ID)
	}
}

func (h *Hub) Close() {
	h.mu.Lock()
	defer h.mu.Unlock()

	for _, client := range h.clients {
		client.closeSendChannel()
		_ = client.Conn.Close()
	}
	h.clients = make(map[string]*Client)
}
