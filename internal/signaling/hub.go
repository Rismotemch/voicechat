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
	"github.com/rs/zerolog"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

type Client struct {
	ID       string
	User     *models.User
	Room     *models.Room
	Conn     *websocket.Conn
	Send     chan []byte
	Hub      *Hub
	PeerConn *webrtc.PeerConnection
	mu       sync.RWMutex
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
	UserID    string                   `json:"userId"`
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
		ID:   generateID(),
		Conn: conn,
		Send: make(chan []byte, 256),
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
	roomState := RoomStateMessage{
		Users: room.GetUsers(),
	}
	c.sendMessage("room_state", roomState)

	// Уведомляем других
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
	if c.PeerConn == nil {
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
	// Создаём SettingEngine для настройки сети
	settingEngine := webrtc.SettingEngine{}

	// Настройка UDP портов
	if h.cfg.UDPMin > 0 && h.cfg.UDPMax > 0 {
		if err := settingEngine.SetEphemeralUDPPortRange(uint16(h.cfg.UDPMin), uint16(h.cfg.UDPMax)); err != nil {
			h.log.Error().Err(err).Msg("Failed to set UDP port range")
		}
	}

	// Если есть домен, используем его для ICE
	if h.cfg.Domain != "" {
		// Резолвим домен в IP
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
					Msg("Setting NAT 1-to-1 IPs from domain")
				settingEngine.SetNAT1To1IPs(ipStrings, webrtc.ICECandidateTypeHost)
			}
		} else {
			h.log.Warn().Err(err).Msg("Failed to resolve domain to IP")
		}
	}

	// Создаём API с настройками
	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))

	// Создаём ICE серверы
	var iceServers []webrtc.ICEServer

	// Добавляем STUN серверы
	if len(h.cfg.STUNServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs: h.cfg.STUNServers,
		})
	}

	// Добавляем TURN серверы
	if len(h.cfg.TURNServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       h.cfg.TURNServers,
			Username:   "openrelayproject",
			Credential: "openrelayproject",
		})
	}

	config := webrtc.Configuration{
		ICEServers: iceServers,
	}

	// Создаём PeerConnection через API
	peerConn, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}

	// Логирование всех ICE кандидатов
peerConn.OnICEGatheringStateChange(func(state webrtc.ICEGathererState) {
    h.log.Info().
        Str("clientId", client.ID).
        Str("gatheringState", state.String()).
        Msg("ICE gathering state changed")
})

	// Логирование выбранной пары кандидатов
	peerConn.OnICECandidatePairChange(func(pair *webrtc.ICECandidatePair) {
   	if pair != nil {
        h.log.Info().
            Str("clientId", client.ID).
            Str("localCandidate", pair.Local.String()).
            Str("remoteCandidate", pair.Remote.String()).
            Msg("ICE candidate pair selected")
    	}
	})

	// Обработка ICE кандидатов
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

	// Обработка входящих треков
	peerConn.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		h.log.Info().
			Str("clientId", client.ID).
			Str("trackID", track.ID()).
			Str("streamID", track.StreamID()).
			Str("codec", track.Codec().MimeType).
			Msg("Received track")

		// Пересылаем трек всем остальным
		h.forwardTrack(client, track)
	})

	// Логирование состояния соединения
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Debug().
			Str("clientId", client.ID).
			Str("state", state.String()).
			Msg("PeerConnection state changed")
	})

	// Логирование ICE состояния
	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		h.log.Debug().
			Str("clientId", client.ID).
			Str("iceState", state.String()).
			Msg("ICE connection state changed")
	})

	return peerConn, nil
}

func (h *Hub) forwardTrack(sender *Client, remoteTrack *webrtc.TrackRemote) {
	h.log.Info().
		Str("senderId", sender.ID).
		Str("trackID", remoteTrack.ID()).
		Msg("Starting track forwarding")

	// Для каждого клиента в комнате
	for _, client := range h.getClientsInRoom(sender.Room.ID) {
		// Пропускаем отправителя
		if client.ID == sender.ID {
			continue
		}

		// Проверяем, что у клиента есть PeerConnection
		if client.PeerConn == nil {
			h.log.Warn().
				Str("clientId", client.ID).
				Msg("Client has no PeerConnection, skipping")
			continue
		}

		h.log.Info().
			Str("fromUser", sender.User.ID).
			Str("toUser", client.User.ID).
			Str("trackID", remoteTrack.ID()).
			Msg("Forwarding track to client")

		// Создаём локальный трек
		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			remoteTrack.ID(),
			remoteTrack.StreamID(),
		)
		if err != nil {
			h.log.Error().Err(err).Msg("Failed to create local track")
			continue
		}

		// Добавляем трек к PeerConnection клиента
		if _, err := client.PeerConn.AddTrack(localTrack); err != nil {
			h.log.Error().Err(err).Msg("Failed to add track to PeerConnection")
			continue
		}

		// Создаём и отправляем новый offer клиенту
		go func(c *Client, remote *webrtc.TrackRemote, local *webrtc.TrackLocalStaticRTP) {
			// Создаём новый offer для клиента
			offer, err := c.PeerConn.CreateOffer(nil)
			if err != nil {
				h.log.Error().Err(err).Msg("Failed to create offer for renegotiation")
				return
			}

			if err := c.PeerConn.SetLocalDescription(offer); err != nil {
				h.log.Error().Err(err).Msg("Failed to set local description")
				return
			}

			// Отправляем offer клиенту
			offerMsg := SDPOfferMessage{
				UserID: c.User.ID,
				Offer:  offer,
			}
			c.sendMessage("sdp_offer", offerMsg)

			// Пересылаем RTP пакеты
			for {
				packet, _, err := remote.ReadRTP()
				if err != nil {
					h.log.Debug().Err(err).Msg("Failed to read RTP packet")
					return
				}

				if err := local.WriteRTP(packet); err != nil {
					h.log.Debug().Err(err).Msg("Failed to write RTP packet")
					return
				}
			}
		}(client, remoteTrack, localTrack)
	}
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
