package signaling

import (
	"encoding/json"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
	"github.com/rs/zerolog"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	ID          string
	User        *models.User
	Room        *models.Room
	Conn        *websocket.Conn
	Send        chan []byte
	Hub         *Hub
	PeerConn    *webrtc.PeerConnection
	localTracks map[string]*webrtc.TrackLocalStaticRTP
	mu          sync.RWMutex
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

type SDPOfferMessage struct {
	UserID string                    `json:"userId"`
	Offer  webrtc.SessionDescription `json:"offer"`
}

type SDPAnswerMessage struct {
	UserID string                    `json:"userId"`
	Answer webrtc.SessionDescription `json:"answer"`
}

type ICECandidateMessage struct {
	UserID    string                  `json:"userId"`
	Candidate webrtc.ICECandidateInit `json:"candidate"`
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

func (c *Client) addLocalTrack(trackID string, track *webrtc.TrackLocalStaticRTP) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.localTracks[trackID] = track
}

func (c *Client) removeLocalTrack(trackID string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.localTracks, trackID)
}

func (c *Client) getLocalTracks() []*webrtc.TrackLocalStaticRTP {
	c.mu.RLock()
	defer c.mu.RUnlock()
	tracks := make([]*webrtc.TrackLocalStaticRTP, 0, len(c.localTracks))
	for _, t := range c.localTracks {
		tracks = append(tracks, t)
	}
	return tracks
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	if h.cfg.RequireAuth && h.cfg.AuthToken != "" {
		token := r.URL.Query().Get("token")
		if token != h.cfg.AuthToken {
			h.log.Warn().Msg("Unauthorized WebSocket connection attempt")
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
	}

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to upgrade WebSocket connection")
		return
	}

	h.log.Info().Msg("New WebSocket connection established")

	client := &Client{
		ID:          generateID(),
		Conn:        conn,
		Send:        make(chan []byte, 256),
		Hub:         h,
		localTracks: make(map[string]*webrtc.TrackLocalStaticRTP),
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

	c.Conn.SetReadLimit(512 * 1024)
	c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.Conn.SetPongHandler(func(string) error {
		c.Conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	for {
		_, message, err := c.Conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				c.Hub.log.Debug().Err(err).Msg("WebSocket read error")
			}
			break
		}

		c.handleMessage(message)
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

			if err := c.Conn.WriteMessage(websocket.TextMessage, message); err != nil {
				return
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
		c.sendError("Invalid message format")
		return
	}

	switch msg.Type {
	case "join":
		var joinMsg JoinMessage
		if err := json.Unmarshal(msg.Payload, &joinMsg); err != nil {
			c.sendError("Invalid join message")
			return
		}
		c.handleJoin(joinMsg)

	case "sdp_offer":
		var offerMsg SDPOfferMessage
		if err := json.Unmarshal(msg.Payload, &offerMsg); err != nil {
			c.sendError("Invalid SDP offer")
			return
		}
		c.handleSDPOffer(offerMsg)

	case "sdp_answer":
		var answerMsg SDPAnswerMessage
		if err := json.Unmarshal(msg.Payload, &answerMsg); err != nil {
			c.sendError("Invalid SDP answer")
			return
		}
		c.handleSDPAnswer(answerMsg)

	case "ice_candidate":
		var iceMsg ICECandidateMessage
		if err := json.Unmarshal(msg.Payload, &iceMsg); err != nil {
			c.sendError("Invalid ICE candidate")
			return
		}
		c.handleICECandidate(iceMsg)

	default:
		c.sendError("Unknown message type: " + msg.Type)
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
	c.sendMessage("room_state", RoomStateMessage{
		Users: room.GetUsers(),
	})

	// Оповещаем остальных
	for _, client := range c.Hub.getClientsInRoom(room.ID) {
		if client.ID != c.ID {
			client.sendMessage("user_joined", UserJoinedMessage{User: user})
		}
	}

	c.Hub.log.Info().
		Str("userId", user.ID).
		Str("room", room.Name).
		Int("totalUsers", room.Count()).
		Msg("User joined room")
}

func (c *Client) handleSDPOffer(msg SDPOfferMessage) {
	c.Hub.log.Debug().
		Str("userId", msg.UserID).
		Msg("Received SDP offer")

	// Закрываем старое соединение если есть
	if c.PeerConn != nil {
		c.PeerConn.Close()
	}

	// Создаём новое PeerConnection
	peerConn, err := c.Hub.createPeerConnection(c)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create PeerConnection")
		c.sendError("Failed to create PeerConnection")
		return
	}

	c.PeerConn = peerConn

	// Устанавливаем remote description
	if err := peerConn.SetRemoteDescription(msg.Offer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set remote description")
		c.sendError("Failed to set remote description")
		return
	}

	// Создаём answer
	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create answer")
		c.sendError("Failed to create answer")
		return
	}

	// Устанавливаем local description
	if err := peerConn.SetLocalDescription(answer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set local description")
		c.sendError("Failed to set local description")
		return
	}

	// Отправляем answer
	answerMsg := SDPAnswerMessage{
		UserID: msg.UserID,
		Answer: answer,
	}
	c.sendMessage("sdp_answer", answerMsg)
}

func (c *Client) handleSDPAnswer(msg SDPAnswerMessage) {
	c.Hub.log.Debug().
		Str("userId", msg.UserID).
		Msg("Received SDP answer for renegotiation")

	if c.PeerConn == nil {
		return
	}

	if err := c.PeerConn.SetRemoteDescription(msg.Answer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set remote description from answer")
	}
}

func (c *Client) handleICECandidate(msg ICECandidateMessage) {
	c.Hub.log.Debug().
		Str("clientId", c.ID).
		Str("candidate", msg.Candidate.Candidate).
		Msg("Received ICE candidate from client")

	if c.PeerConn == nil {
		c.Hub.log.Warn().Str("clientId", c.ID).Msg("PeerConn is nil, dropping candidate")
		return
	}

	if err := c.PeerConn.AddICECandidate(msg.Candidate); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to add ICE candidate")
	}
}

func (c *Client) sendMessage(msgType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to marshal message payload")
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
		c.Hub.log.Warn().Msg("Client send channel is full, dropping message")
	}
}

func (c *Client) sendError(message string) {
	c.sendMessage("error", ErrorMessage{Message: message})
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
			c.sendMessage("user_left", UserLeftMessage{UserID: client.User.ID})
		}

		h.log.Info().
			Str("userId", client.User.ID).
			Str("room", client.Room.Name).
			Int("totalUsers", client.Room.Count()).
			Msg("User left room")
	}

	if client.PeerConn != nil {
		client.PeerConn.Close()
	}
}

func (h *Hub) createPeerConnection(client *Client) (*webrtc.PeerConnection, error) {
	settingEngine := webrtc.SettingEngine{}

	// 1. Ограничение пула UDP портов
	if h.cfg.UDPMin > 0 && h.cfg.UDPMax > 0 {
		if err := settingEngine.SetEphemeralUDPPortRange(uint16(h.cfg.UDPMin), uint16(h.cfg.UDPMax)); err != nil {
			h.log.Error().Err(err).Msg("Failed to set UDP port range")
		}
	}

	// 2. Динамический резолв домена в текущий публичный IP
	if h.cfg.Domain != "" && h.cfg.Domain != "localhost" {
		ips, err := net.LookupIP(h.cfg.Domain)
		if err == nil && len(ips) > 0 {
			var ipStrings []string
			for _, ip := range ips {
				if ipv4 := ip.To4(); ipv4 != nil {
					ipStrings = append(ipStrings, ipv4.String())
				}
			}
			if len(ipStrings) > 0 {
				h.log.Info().
					Strs("ips", ipStrings).
					Msg("Setting NAT 1-to-1 IPs dynamically from domain")
				settingEngine.SetNAT1To1IPs(ipStrings, webrtc.ICECandidateTypeHost)
			}
		} else {
			h.log.Warn().Err(err).Str("domain", h.cfg.Domain).Msg("Failed to resolve dynamic domain IP")
		}
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))

	// 3. Серверу НЕ передаем ICEServers (STUN/TURN нужны только браузерам)
	// Это исключает появление паразитных локальных srflx (192.168.1.1)
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{},
	}

	peerConn, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}

	// 4. Обработка ICE кандидатов от Pion к клиенту
	peerConn.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			h.log.Debug().
				Str("clientId", client.ID).
				Str("candidate", candidate.String()).
				Msg("Generated ICE candidate")

			candidateMsg := ICECandidateMessage{
				UserID:    client.User.ID,
				Candidate: candidate.ToJSON(),
			}
			client.sendMessage("ice_candidate", candidateMsg)
		}
	})

	// 5. Обработка входящих аудио-треков
	peerConn.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		h.log.Info().
			Str("clientId", client.ID).
			Str("trackID", track.ID()).
			Str("codec", track.Codec().MimeType).
			Msg("Received remote track from client")

		h.forwardTrack(client, track)
	})

	// Логирование состояний
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Debug().
			Str("clientId", client.ID).
			Str("state", state.String()).
			Msg("PeerConnection state changed")
	})

	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		h.log.Debug().
			Str("clientId", client.ID).
			Str("iceState", state.String()).
			Msg("ICE connection state changed")
	})

	return peerConn, nil
}

// forwardTrack вызывается при получении OnTrack от клиента
func (h *Hub) forwardTrack(sender *Client, remoteTrack *webrtc.TrackRemote) {
	h.log.Info().
		Str("senderId", sender.ID).
		Str("trackID", remoteTrack.ID()).
		Str("codec", remoteTrack.Codec().MimeType).
		Msg("Started forwarding remote track")

	localTrack, err := webrtc.NewTrackLocalStaticRTP(
		remoteTrack.Codec().RTPCodecCapability,
		remoteTrack.ID(),
		remoteTrack.StreamID(),
	)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to create local track")
		return
	}

	// Сохраняем локальный трек у отправителя в хабе
	sender.addLocalTrack(remoteTrack.ID(), localTrack)

	// Добавляем этот трек всем другим клиентам комнаты
	h.mu.RLock()
	for _, client := range h.getClientsInRoom(sender.Room.ID) {
		if client.ID != sender.ID && client.PeerConn != nil {
			h.attachTrackToClient(client, localTrack)
		}
	}
	h.mu.RUnlock()

	// Читаем пакеты от отправителя и пишем в localTrack
	go func() {
		buf := make([]byte, 1500)
		for {
			n, _, readErr := remoteTrack.Read(buf)
			if readErr != nil {
				return
			}
			if _, writeErr := localTrack.Write(buf[:n]); writeErr != nil {
				continue
			}
		}
	}()
}

// attachTrackToClient безопасно добавляет трек клиенту и инициирует renegotiation
func (h *Hub) attachTrackToClient(client *Client, track *webrtc.TrackLocalStaticRTP) {
	client.mu.Lock()
	if client.PeerConn == nil {
		client.mu.Unlock()
		return
	}

	// Проверяем, не добавлен ли уже
	if _, exists := client.localTracks[track.ID()]; exists {
		client.mu.Unlock()
		return
	}

	sender, err := client.PeerConn.AddTrack(track)
	if err != nil {
		client.mu.Unlock()
		h.log.Error().Err(err).Msg("Failed to add track to PeerConnection")
		return
	}
	_ = sender

	client.localTracks[track.ID()] = track
	client.mu.Unlock()

	// Инициируем Renegotiation (Offer -> Client -> Answer)
	go func(c *Client) {
		offer, err := c.PeerConn.CreateOffer(nil)
		if err != nil {
			h.log.Error().Err(err).Msg("Failed to create offer for renegotiation")
			return
		}

		if err := c.PeerConn.SetLocalDescription(offer); err != nil {
			h.log.Error().Err(err).Msg("Failed to set local description")
			return
		}

		offerMsg := SDPOfferMessage{
			UserID: c.User.ID,
			Offer:  offer,
		}
		c.sendMessage("sdp_offer", offerMsg)
	}(client)
}

func generateID() string {
	return "client_" + uuid.New().String()
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
		if client.PeerConn != nil {
			client.PeerConn.Close()
		}
		client.Conn.Close()
	}
}
