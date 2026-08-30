package signaling

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
	"github.com/rs/zerolog"
)

const (
	writeWait      = 5 * time.Second
	pongWait       = 60 * time.Second
	pingPeriod     = (pongWait * 9) / 10
	maxMessageSize = 512 * 1024
	sendChannelCap = 4
	maxChatTextLen = 2000
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

// SendAudioDropOldest отправляет аудио-пакет. Если канал переполнен из-за лага TCP,
// удаляется самый старый пакет из очереди и записывается свежий кадр реального времени.
func (c *Client) SendAudioDropOldest(msg []byte) {
	select {
	case c.Send <- msg:
		return
	default:
		// Вытесняем старый пакет
		select {
		case <-c.Send:
		default:
		}
		// Записываем актуальный
		select {
		case c.Send <- msg:
		default:
		}
	}
}

// =============================================================================
// Hub: Маршрутизатор комнат, чата и медиа-потоков
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

	defaultRoom := models.NewRoom("main", cfg.MaxUsers)
	defaultRoom.ID = "main"
	hub.rooms["main"] = defaultRoom
	hub.audioHubs["main"] = NewAudioHub()

	return hub
}

// HandleMinecraftTelemetry принимает телеметрию от Forge-мода и рассылает в MC-комнаты
func (h *Hub) HandleMinecraftTelemetry(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var payload models.MinecraftPayload
	if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
		h.log.Warn().Err(err).Msg("Invalid MC telemetry payload")
		http.Error(w, `{"error":"Invalid payload"}`, http.StatusBadRequest)
		return
	}

	var mcRoomIDs []string
	h.mu.RLock()
	for _, room := range h.rooms {
		if room.MinecraftMode {
			mcRoomIDs = append(mcRoomIDs, room.ID)
		}
	}
	h.mu.RUnlock()

	h.log.Info().
		Int("players", len(payload.Players)).
		Int("mcRooms", len(mcRoomIDs)).
		Msg("Received Minecraft telemetry")

	for _, roomID := range mcRoomIDs {
		h.broadcastToRoom(roomID, "minecraft_telemetry", map[string]interface{}{
			"players": payload.Players,
		}, "")
	}

	w.WriteHeader(http.StatusOK)
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Error().Err(err).Msg("WebSocket upgrade failed")
		return
	}

	// Отключение буферизации Nagle на уровне сетевого стека ОС
	if netConn := conn.UnderlyingConn(); netConn != nil {
		if tcpConn, ok := netConn.(*net.TCPConn); ok {
			_ = tcpConn.SetNoDelay(true)
			_ = tcpConn.SetKeepAlive(true)
			_ = tcpConn.SetKeepAlivePeriod(30 * time.Second)
		}
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

func (h *Hub) HandleUpload(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"Method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	maxSize := h.cfg.MaxUploadSize
	if maxSize <= 0 {
		maxSize = 50 << 20 // 50 MB
	}
	r.Body = http.MaxBytesReader(w, r.Body, maxSize)

	if err := r.ParseMultipartForm(maxSize); err != nil {
		h.log.Warn().Err(err).Msg("File upload size exceeded limit")
		http.Error(w, `{"error":"File size exceeds maximum allowed limit"}`, http.StatusBadRequest)
		return
	}

	file, header, err := r.FormFile("file")
	if err != nil {
		http.Error(w, `{"error":"Missing file in payload"}`, http.StatusBadRequest)
		return
	}
	defer file.Close()

	if err := os.MkdirAll(h.cfg.UploadPath, 0755); err != nil {
		h.log.Error().Err(err).Msg("Failed to create upload directory")
		http.Error(w, `{"error":"Internal storage error"}`, http.StatusInternalServerError)
		return
	}

	ext := strings.ToLower(filepath.Ext(header.Filename))
	uniqueFileName := fmt.Sprintf("%s_%s%s", time.Now().Format("20060102150405"), uuid.New().String()[:8], ext)
	dstPath := filepath.Join(h.cfg.UploadPath, uniqueFileName)

	dst, err := os.Create(dstPath)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to save uploaded file")
		http.Error(w, `{"error":"Failed to save file"}`, http.StatusInternalServerError)
		return
	}
	defer dst.Close()

	written, err := io.Copy(dst, file)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to write file stream")
		http.Error(w, `{"error":"File write error"}`, http.StatusInternalServerError)
		return
	}

	fileType := "file"
	switch ext {
	case ".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg":
		fileType = "image"
	case ".mp3", ".wav", ".ogg", ".m4a":
		fileType = "audio"
	}

	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(map[string]interface{}{
		"url":      "/uploads/" + uniqueFileName,
		"fileName": header.Filename,
		"fileSize": written,
		"fileType": fileType,
	})
}

// =============================================================================
// I/O Pumps
// =============================================================================

func (c *Client) readPump() {
	defer func() {
		c.Hub.removeClient(c)
		_ = c.Conn.Close()
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
				c.Hub.log.Warn().Err(err).Str("clientId", c.ID).Msg("WebSocket read loop closed")
			}
			break
		}

		switch messageType {
		case websocket.BinaryMessage:
			c.handleAudioData(message)
		case websocket.TextMessage:
			c.handleTextMessage(message)
		}
	}
}

func (c *Client) writePump() {
	ticker := time.NewTicker(pingPeriod)
	defer func() {
		ticker.Stop()
		_ = c.Conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.Send:
			_ = c.Conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.Conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

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
// Сигнальные структуры
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
	RoomName      string `json:"roomName"`
	Password      string `json:"password,omitempty"`
	MaxUsers      int    `json:"maxUsers,omitempty"`
	MinecraftMode bool   `json:"minecraftMode,omitempty"`
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

type PingMessage struct {
	ClientTimestamp int64 `json:"clientTimestamp"`
}

type PingReportMessage struct {
	PingMs int `json:"pingMs"`
}

type KickUserMessage struct {
	TargetUserID string `json:"targetUserId"`
}

type LockRoomMessage struct {
	IsLocked bool `json:"isLocked"`
}

type MuteAllMessage struct {
	IsMuted bool `json:"isMuted"`
}

type SendChatMessage struct {
	Content string `json:"content"`
}

type SendFileMessage struct {
	FileURL  string `json:"fileUrl"`
	FileName string `json:"fileName"`
	FileType string `json:"fileType"`
	FileSize int64  `json:"fileSize"`
}

type SetVoiceFilterMessage struct {
	Filter string `json:"filter"`
}

// =============================================================================
// Обработка текстовых команд и чата
// =============================================================================

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

	case "send_message":
		var p SendChatMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleSendMessage(p)
		}
	case "send_file":
		var p SendFileMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleSendFile(p)
		}

	case "set_voice_filter":
		var p SetVoiceFilterMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleSetVoiceFilter(p)
		}

	case "ping":
		var p PingMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handlePing(p)
		}
	case "ping_report":
		var p PingReportMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handlePingReport(p)
		}

	case "kick_user":
		var p KickUserMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleKickUser(p)
		}
	case "lock_room":
		var p LockRoomMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleLockRoom(p)
		}
	case "mute_all":
		var p MuteAllMessage
		if err := json.Unmarshal(msg.Payload, &p); err == nil {
			c.handleMuteAll(p)
		}
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

	audioHub, aHubExists := c.Hub.audioHubs[roomID]
	if !aHubExists {
		audioHub = NewAudioHub()
		c.Hub.audioHubs[roomID] = audioHub
	}
	c.Hub.mu.Unlock()

	if c.Room != nil {
		c.handleLeave(LeaveMessage{RoomID: c.Room.ID})
	}

	user := models.NewUser(msg.UserID, msg.UserName, msg.AvatarColor)

	if err := room.AddUser(user); err != nil {
		if err == models.ErrRoomLocked {
			c.sendError("Комната заблокирована хостом")
		} else {
			c.sendError("Комната заполнена")
		}
		return
	}

	// Передаем ссылку на метод отправки дропа устаревших пакетов
	audioClient := NewAudioClient(c.ID, user.ID, c.SendAudioDropOldest)
	audioHub.AddClient(audioClient)

	c.mu.Lock()
	c.User = user
	c.Room = room
	c.AudioClient = audioClient
	c.mu.Unlock()

	c.sendJSON("room_state", map[string]interface{}{
		"users":         room.GetUsers(),
		"messages":      room.GetMessages(),
		"hostId":        room.HostID,
		"isLocked":      room.IsLocked,
		"minecraftMode": room.MinecraftMode,
	})

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

	newHostID := room.RemoveUser(user.ID)

	c.Hub.mu.RLock()
	audioHub := c.Hub.audioHubs[room.ID]
	c.Hub.mu.RUnlock()

	if audioHub != nil && audioClient != nil {
		audioHub.RemoveClient(c.ID)
	}

	c.Hub.broadcastToRoom(room.ID, "user_left", map[string]interface{}{
		"userId": user.ID,
	}, c.ID)

	if newHostID != "" {
		c.Hub.broadcastToRoom(room.ID, "host_changed", map[string]interface{}{
			"hostId": newHostID,
		}, "")
	}
}

func (c *Client) handleSendMessage(msg SendChatMessage) {
	text := strings.TrimSpace(msg.Content)
	if text == "" {
		return
	}
	if len(text) > maxChatTextLen {
		text = text[:maxChatTextLen]
	}

	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil {
		return
	}

	chatMsg := models.NewChatMessage(room.ID, user.ID, user.Name, user.AvatarColor, text)
	room.AddMessage(chatMsg)

	c.Hub.broadcastToRoom(room.ID, "chat_message", chatMsg, "")
}

func (c *Client) handleSendFile(msg SendFileMessage) {
	if msg.FileURL == "" || msg.FileName == "" {
		return
	}

	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil {
		return
	}

	chatMsg := models.NewFileChatMessage(room.ID, user.ID, user.Name, user.AvatarColor, msg.FileURL, msg.FileName, msg.FileType, msg.FileSize)
	room.AddMessage(chatMsg)

	c.Hub.broadcastToRoom(room.ID, "chat_message", chatMsg, "")
}

func (c *Client) handleSetVoiceFilter(msg SetVoiceFilterMessage) {
	validFilters := map[string]bool{
		"none":      true,
		"radio":     true,
		"robot":     true,
		"megaphone": true,
		"demon":     true,
	}

	filter := strings.ToLower(msg.Filter)
	if !validFilters[filter] {
		filter = "none"
	}

	c.mu.Lock()
	if c.AudioClient != nil {
		c.AudioClient.SetVoiceFilter(filter)
	}
	if c.User != nil {
		c.User.VoiceFilter = filter
	}
	room := c.Room
	user := c.User
	c.mu.Unlock()

	if room != nil && user != nil {
		room.SetUserVoiceFilter(user.ID, filter)
		c.Hub.broadcastToRoom(room.ID, "user_filter_updated", map[string]interface{}{
			"userId":      user.ID,
			"voiceFilter": filter,
		}, "")
	}
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
	if maxUsers <= 0 || maxUsers > models.MaxAllowedUsersPerRoom {
		maxUsers = models.DefaultMaxUsers
	}

	room := models.NewRoom(msg.RoomName, maxUsers)
	room.Password = msg.Password
	room.MinecraftMode = msg.MinecraftMode

	c.Hub.rooms[room.ID] = room
	c.Hub.audioHubs[room.ID] = NewAudioHub()
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

func (c *Client) handlePing(msg PingMessage) {
	c.sendJSON("pong", map[string]interface{}{
		"clientTimestamp": msg.ClientTimestamp,
		"serverTimestamp": time.Now().UnixMilli(),
	})
}

func (c *Client) handlePingReport(msg PingReportMessage) {
	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil {
		return
	}

	room.UpdateUserPing(user.ID, msg.PingMs)

	c.Hub.broadcastToRoom(room.ID, "user_ping_updated", map[string]interface{}{
		"userId": user.ID,
		"pingMs": msg.PingMs,
	}, "")
}

func (c *Client) handleKickUser(msg KickUserMessage) {
	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil || !room.IsUserHost(user.ID) {
		c.sendError("Только создатель комнаты может исключать участников")
		return
	}

	if msg.TargetUserID == user.ID {
		c.sendError("Нельзя исключить самого себя")
		return
	}

	var targetClient *Client
	c.Hub.mu.RLock()
	for _, cl := range c.Hub.clients {
		cl.mu.RLock()
		if cl.User != nil && cl.User.ID == msg.TargetUserID && cl.Room != nil && cl.Room.ID == room.ID {
			targetClient = cl
		}
		cl.mu.RUnlock()
		if targetClient != nil {
			break
		}
	}
	c.Hub.mu.RUnlock()

	if targetClient != nil {
		targetClient.sendJSON("kicked", map[string]string{
			"message": "Вы были исключены создателем комнаты",
		})
		c.Hub.removeClient(targetClient)
	}
}

func (c *Client) handleLockRoom(msg LockRoomMessage) {
	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil || !room.IsUserHost(user.ID) {
		c.sendError("Только создатель комнаты может блокировать вход")
		return
	}

	room.SetLocked(msg.IsLocked)

	c.Hub.broadcastToRoom(room.ID, "room_locked_updated", map[string]interface{}{
		"isLocked": msg.IsLocked,
	}, "")
}

func (c *Client) handleMuteAll(msg MuteAllMessage) {
	c.mu.RLock()
	room := c.Room
	user := c.User
	c.mu.RUnlock()

	if room == nil || user == nil || !room.IsUserHost(user.ID) {
		c.sendError("Только создатель комнаты может управлять общим звуком")
		return
	}

	c.Hub.mu.RLock()
	for _, cl := range c.Hub.clients {
		cl.mu.RLock()
		inRoom := cl.Room != nil && cl.Room.ID == room.ID
		isSelf := cl.User != nil && cl.User.ID == user.ID
		cl.mu.RUnlock()

		if inRoom && !isSelf {
			if cl.AudioClient != nil {
				cl.AudioClient.SetMute(true)
			}
			cl.sendJSON("force_mute", map[string]bool{"isMuted": true})
			c.Hub.broadcastToRoom(room.ID, "user_muted", map[string]interface{}{
				"userId":  cl.User.ID,
				"isMuted": true,
			}, "")
		}
	}
	c.Hub.mu.RUnlock()
}

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
		audioHub.ProcessAndBroadcast(c.ID, audioData)
	}
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
		newHostID := room.RemoveUser(user.ID)

		h.mu.RLock()
		audioHub := h.audioHubs[room.ID]
		h.mu.RUnlock()

		if audioHub != nil {
			audioHub.RemoveClient(client.ID)
		}

		h.broadcastToRoom(room.ID, "user_left", map[string]interface{}{
			"userId": user.ID,
		}, client.ID)

		if newHostID != "" {
			h.broadcastToRoom(room.ID, "host_changed", map[string]interface{}{
				"hostId": newHostID,
			}, "")
		}
	}
}

func (h *Hub) GetRoomUserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
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
