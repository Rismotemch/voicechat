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
	ID                string
	User              *models.User
	Room              *models.Room
	Conn              *websocket.Conn
	Send              chan []byte
	Hub               *Hub
	PeerConn          *webrtc.PeerConnection
	pendingCandidates []webrtc.ICECandidateInit
	mu                sync.RWMutex
}

type Hub struct {
	cfg          *config.Config
	log          zerolog.Logger
	rooms        map[string]*models.Room
	clients      map[string]*Client
	activeTracks map[string]*webrtc.TrackLocalStaticRTP
	trackOwners  map[string]string
	mu           sync.RWMutex
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
		cfg:          cfg,
		log:          log,
		rooms:        make(map[string]*models.Room),
		clients:      make(map[string]*Client),
		activeTracks: make(map[string]*webrtc.TrackLocalStaticRTP),
		trackOwners:  make(map[string]string),
	}

	room := models.NewRoom(cfg.RoomName, cfg.MaxUsers)
	hub.rooms[cfg.RoomName] = room

	log.Info().Str("room", cfg.RoomName).Int("maxUsers", cfg.MaxUsers).Msg("Created default room")

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
		ID:                "client_" + uuid.New().String(),
		Conn:              conn,
		Send:              make(chan []byte, 256),
		Hub:               h,
		pendingCandidates: make([]webrtc.ICECandidateInit, 0),
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
			c.Conn.WriteMessage(websocket.TextMessage, message)
		case <-ticker.C:
			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			c.Conn.WriteMessage(websocket.PingMessage, nil)
		}
	}
}

func (c *Client) handleMessage(data []byte) {
	var msg Message
	if err := json.Unmarshal(data, &msg); err != nil {
		return
	}

	switch msg.Type {
	case "join":
		var joinMsg JoinMessage
		if err := json.Unmarshal(msg.Payload, &joinMsg); err == nil {
			c.handleJoin(joinMsg)
		}
	case "sdp_offer":
		var offerMsg SDPOfferMessage
		if err := json.Unmarshal(msg.Payload, &offerMsg); err == nil {
			c.handleSDPOffer(offerMsg)
		}
	case "sdp_answer":
		var answerMsg SDPAnswerMessage
		if err := json.Unmarshal(msg.Payload, &answerMsg); err == nil {
			c.handleSDPAnswer(answerMsg)
		}
	case "ice_candidate":
		var iceMsg ICECandidateMessage
		if err := json.Unmarshal(msg.Payload, &iceMsg); err == nil {
			c.handleICECandidate(iceMsg)
		}
	}
}

func (c *Client) handleJoin(msg JoinMessage) {
	user := &models.User{
		ID:          msg.UserID,
		Name:        msg.UserName,
		AvatarColor: msg.AvatarColor,
		JoinedAt:    time.Now(),
	}

	room := c.Hub.getRoom()
	if room == nil || room.AddUser(user) != nil {
		c.sendMessage("error", ErrorMessage{Message: "Room full or unavailable"})
		return
	}

	c.User = user
	c.Room = room

	c.Hub.log.Info().Str("userId", user.ID).Str("userName", user.Name).Msg("User joined room")

	c.sendMessage("room_state", RoomStateMessage{Users: room.GetUsers()})

	for _, client := range c.Hub.getClientsInRoom(room.ID) {
		if client.ID != c.ID {
			client.sendMessage("user_joined", UserJoinedMessage{User: user})
		}
	}
}

func (c *Client) handleSDPOffer(msg SDPOfferMessage) {
	c.Hub.log.Info().Str("userId", msg.UserID).Msg("Received SDP offer")

	if c.PeerConn != nil {
		c.PeerConn.Close()
	}

	peerConn, err := c.Hub.createPeerConnection(c)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create PeerConnection")
		c.sendMessage("error", ErrorMessage{Message: "Failed to create PeerConnection"})
		return
	}

	c.mu.Lock()
	c.PeerConn = peerConn
	c.mu.Unlock()

	// Добавляем все существующие треки
	c.Hub.mu.RLock()
	for trackID, track := range c.Hub.activeTracks {
		ownerID := c.Hub.trackOwners[trackID]
		if ownerID != c.ID {
			if _, err := c.PeerConn.AddTrack(track); err != nil {
				c.Hub.log.Error().Err(err).Str("trackId", trackID).Msg("Failed to add existing track")
			}
		}
	}
	c.Hub.mu.RUnlock()

	if err := peerConn.SetRemoteDescription(msg.Offer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set remote description")
		return
	}

	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create answer")
		return
	}

	if err := peerConn.SetLocalDescription(answer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set local description")
		return
	}

	// Добавляем отложенные ICE кандидаты
	c.mu.Lock()
	for _, cand := range c.pendingCandidates {
		peerConn.AddICECandidate(cand)
	}
	c.pendingCandidates = nil
	c.mu.Unlock()

	c.sendMessage("sdp_answer", SDPAnswerMessage{
		UserID: msg.UserID,
		Answer: answer,
	})
}

func (c *Client) handleSDPAnswer(msg SDPAnswerMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.PeerConn != nil {
		if err := c.PeerConn.SetRemoteDescription(msg.Answer); err != nil {
			c.Hub.log.Error().Err(err).Msg("Failed to set remote description from answer")
		}
	}
}

func (c *Client) handleICECandidate(msg ICECandidateMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()

	if c.PeerConn == nil || c.PeerConn.RemoteDescription() == nil {
		c.pendingCandidates = append(c.pendingCandidates, msg.Candidate)
		return
	}

	if err := c.PeerConn.AddICECandidate(msg.Candidate); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to add ICE candidate")
	}
}

func (h *Hub) createPeerConnection(client *Client) (*webrtc.PeerConnection, error) {
	settingEngine := webrtc.SettingEngine{}

	if h.cfg.UDPMin > 0 && h.cfg.UDPMax > 0 {
		if err := settingEngine.SetEphemeralUDPPortRange(uint16(h.cfg.UDPMin), uint16(h.cfg.UDPMax)); err != nil {
			h.log.Error().Err(err).Msg("Failed to set UDP port range")
		}
	}

	if h.cfg.Domain != "" && h.cfg.Domain != "localhost" {
		if ips, err := net.LookupIP(h.cfg.Domain); err == nil && len(ips) > 0 {
			var ipStrings []string
			for _, ip := range ips {
				if ipv4 := ip.To4(); ipv4 != nil {
					ipStrings = append(ipStrings, ipv4.String())
				}
			}
			if len(ipStrings) > 0 {
				h.log.Info().Strs("ips", ipStrings).Msg("Setting NAT 1-to-1 IPs")
				settingEngine.SetNAT1To1IPs(ipStrings, webrtc.ICECandidateTypeHost)
			}
		}
	}

	api := webrtc.NewAPI(webrtc.WithSettingEngine(settingEngine))

	// Настраиваем ICE серверы
	var iceServers []webrtc.ICEServer

	// Добавляем STUN
	if len(h.cfg.STUNServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs: h.cfg.STUNServers,
		})
	}

	// Добавляем TURN
	if len(h.cfg.TURNServers) > 0 {
		iceServers = append(iceServers, webrtc.ICEServer{
			URLs:       h.cfg.TURNServers,
			Username:   "voicechat",
			Credential: "voicechat123",
		})
	}

	config := webrtc.Configuration{
		ICEServers: iceServers,
	}

	peerConn, err := api.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}

	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Info().Str("clientId", client.ID).Str("state", state.String()).Msg("PeerConnection state")
	})

	peerConn.OnICEConnectionStateChange(func(state webrtc.ICEConnectionState) {
		h.log.Info().Str("clientId", client.ID).Str("state", state.String()).Msg("ICE connection state")
	})

	peerConn.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			h.log.Info().Str("candidate", candidate.String()).Msg("Generated ICE candidate")
			client.sendMessage("ice_candidate", ICECandidateMessage{
				UserID:    client.User.ID,
				Candidate: candidate.ToJSON(),
			})
		}
	})

	peerConn.OnTrack(func(remoteTrack *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		h.log.Info().
			Str("clientId", client.ID).
			Str("trackId", remoteTrack.ID()).
			Str("codec", remoteTrack.Codec().MimeType).
			Msg("Received track from client")

		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			remoteTrack.Codec().RTPCodecCapability,
			remoteTrack.ID(),
			remoteTrack.StreamID(),
		)
		if err != nil {
			h.log.Error().Err(err).Msg("Failed to create local track")
			return
		}

		h.mu.Lock()
		h.activeTracks[localTrack.ID()] = localTrack
		h.trackOwners[localTrack.ID()] = client.ID
		h.mu.Unlock()

		// Пересылаем трек всем остальным
		for _, otherClient := range h.getClientsInRoom(client.Room.ID) {
			if otherClient.ID != client.ID && otherClient.PeerConn != nil {
				if _, err := otherClient.PeerConn.AddTrack(localTrack); err == nil {
					h.log.Info().
						Str("fromUser", client.User.ID).
						Str("toUser", otherClient.User.ID).
						Msg("Forwarding track")
					go h.renegotiateClient(otherClient)
				}
			}
		}

		// Копируем RTP пакеты
		go func() {
			defer func() {
				h.mu.Lock()
				delete(h.activeTracks, localTrack.ID())
				delete(h.trackOwners, localTrack.ID())
				h.mu.Unlock()
			}()
			for {
				packet, _, err := remoteTrack.ReadRTP()
				if err != nil {
					return
				}
				if err := localTrack.WriteRTP(packet); err != nil {
					return
				}
			}
		}()
	})

	return peerConn, nil
}

func (h *Hub) renegotiateClient(client *Client) {
	client.mu.Lock()
	defer client.mu.Unlock()

	if client.PeerConn == nil || client.PeerConn.SignalingState() != webrtc.SignalingStateStable {
		return
	}

	offer, err := client.PeerConn.CreateOffer(nil)
	if err != nil {
		h.log.Error().Err(err).Msg("Failed to create renegotiation offer")
		return
	}

	if err := client.PeerConn.SetLocalDescription(offer); err != nil {
		h.log.Error().Err(err).Msg("Failed to set local description for renegotiation")
		return
	}

	client.sendMessage("sdp_offer", SDPOfferMessage{
		UserID: client.User.ID,
		Offer:  offer,
	})
}

func (c *Client) sendMessage(msgType string, payload interface{}) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}

	msg := Message{
		Type:    msgType,
		Payload: data,
	}

	msgData, _ := json.Marshal(msg)
	select {
	case c.Send <- msgData:
	default:
	}
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
	h.log.Info().Str("clientId", client.ID).Msg("Client disconnected")

	h.mu.Lock()
	delete(h.clients, client.ID)

	for trackID, ownerID := range h.trackOwners {
		if ownerID == client.ID {
			delete(h.activeTracks, trackID)
			delete(h.trackOwners, trackID)
		}
	}
	h.mu.Unlock()

	if client.Room != nil && client.User != nil {
		client.Room.RemoveUser(client.User.ID)
		for _, c := range h.getClientsInRoom(client.Room.ID) {
			c.sendMessage("user_left", UserLeftMessage{UserID: client.User.ID})
		}
	}

	if client.PeerConn != nil {
		client.PeerConn.Close()
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
		if client.PeerConn != nil {
			client.PeerConn.Close()
		}
		client.Conn.Close()
	}
}
