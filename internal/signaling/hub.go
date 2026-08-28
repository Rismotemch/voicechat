package signaling

import (
	"encoding/json"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v3"
	"github.com/rs/zerolog"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
	"github.com/google/uuid"
)

var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		// В production можно проверять origin
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
	cfg      *config.Config
	log      zerolog.Logger
	rooms    map[string]*models.Room
	clients  map[string]*Client
	mu       sync.RWMutex
}

type Message struct {
	Type    string          `json:"type"`
	Payload json.RawMessage `json:"payload,omitempty"`
}

type JoinMessage struct {
	UserID   string `json:"userId"`
	UserName string `json:"userName"`
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
	UserID   string                   `json:"userId"`
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

	// Create default room
	room := models.NewRoom(cfg.RoomName, cfg.MaxUsers)
	hub.rooms[cfg.RoomName] = room

	log.Info().
		Str("room", cfg.RoomName).
		Int("maxUsers", cfg.MaxUsers).
		Msg("Created default room")

	return hub
}

func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Check auth token if configured
	if h.cfg.AuthToken != "" {
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

	// Register client
	h.mu.Lock()
	h.clients[client.ID] = client
	h.mu.Unlock()

	// Start goroutines
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
				c.Hub.log.Error().Err(err).Msg("WebSocket read error")
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

			c.Conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
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

	// Create user
	user := &models.User{
		ID:          msg.UserID,
		Name:        msg.UserName,
		AvatarColor: msg.AvatarColor,
		JoinedAt:    time.Now(),
	}

	// Get room
	room := c.Hub.getRoom()
	if room == nil {
		c.sendError("Room not found")
		return
	}

	// Add user to room
	if err := room.AddUser(user); err != nil {
		c.sendError("Room is full")
		return
	}

	c.User = user
	c.Room = room

	// Send current room state to the new user
	roomState := RoomStateMessage{
		Users: room.GetUsers(),
	}
	c.sendMessage("room_state", roomState)

	// Notify other users about new participant
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

	// Create PeerConnection for this client
	peerConn, err := c.Hub.createPeerConnection(c)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create PeerConnection")
		c.sendError("Failed to create PeerConnection")
		return
	}

	c.PeerConn = peerConn

	// Set remote description
	if err := peerConn.SetRemoteDescription(msg.Offer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set remote description")
		c.sendError("Failed to set remote description")
		return
	}

	// Create answer
	answer, err := peerConn.CreateAnswer(nil)
	if err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to create answer")
		c.sendError("Failed to create answer")
		return
	}

	// Set local description
	if err := peerConn.SetLocalDescription(answer); err != nil {
		c.Hub.log.Error().Err(err).Msg("Failed to set local description")
		c.sendError("Failed to set local description")
		return
	}

	// Send answer back to client
	answerMsg := SDPAnswerMessage{
		UserID: msg.UserID,
		Answer: answer,
	}
	c.sendMessage("sdp_answer", answerMsg)
}

func (c *Client) handleICECandidate(msg ICECandidateMessage) {
	c.Hub.log.Debug().
		Str("userId", msg.UserID).
		Msg("Received ICE candidate")

	if c.PeerConn == nil {
		c.Hub.log.Warn().Msg("PeerConnection is nil, cannot add ICE candidate")
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

	// Remove from clients map
	h.mu.Lock()
	delete(h.clients, client.ID)
	h.mu.Unlock()

	// Remove from room
	if client.Room != nil && client.User != nil {
		client.Room.RemoveUser(client.User.ID)

		// Notify other users
		for _, c := range h.getClientsInRoom(client.Room.ID) {
			c.sendMessage("user_left", UserLeftMessage{UserID: client.User.ID})
		}

		h.log.Info().
			Str("userId", client.User.ID).
			Str("room", client.Room.Name).
			Int("totalUsers", client.Room.Count()).
			Msg("User left room")
	}

	// Close PeerConnection if exists
	if client.PeerConn != nil {
		client.PeerConn.Close()
	}
}

func (h *Hub) createPeerConnection(client *Client) (*webrtc.PeerConnection, error) {
	// Create WebRTC configuration
	config := webrtc.Configuration{
		ICEServers: []webrtc.ICEServer{
			{
				URLs: h.cfg.STUNServers,
			},
		},
	}

	// Create PeerConnection
	peerConn, err := webrtc.NewPeerConnection(config)
	if err != nil {
		return nil, err
	}

	// Handle ICE candidate generation
	peerConn.OnICECandidate(func(candidate *webrtc.ICECandidate) {
		if candidate != nil {
			candidateMsg := ICECandidateMessage{
				UserID:   client.User.ID,
				Candidate: candidate.ToJSON(),
			}
			client.sendMessage("ice_candidate", candidateMsg)
		}
	})

	// Handle incoming tracks
	peerConn.OnTrack(func(track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
		h.log.Info().
			Str("clientId", client.ID).
			Str("trackKind", track.Kind().String()).
			Msg("Received track")

		// Forward track to all other clients in the room
		h.forwardTrack(client, track, receiver)
	})

	// Handle connection state changes
	peerConn.OnConnectionStateChange(func(state webrtc.PeerConnectionState) {
		h.log.Debug().
			Str("clientId", client.ID).
			Str("state", state.String()).
			Msg("PeerConnection state changed")
	})

	return peerConn, nil
}

func (h *Hub) forwardTrack(sender *Client, track *webrtc.TrackRemote, receiver *webrtc.RTPReceiver) {
	// Get all other clients in the room
	for _, client := range h.getClientsInRoom(sender.Room.ID) {
		if client.ID == sender.ID || client.PeerConn == nil {
			continue
		}

		// Create a local track to send to the client
		localTrack, err := webrtc.NewTrackLocalStaticRTP(
			track.Codec().RTPCodecCapability,
			track.ID(),
			track.StreamID(),
		)
		if err != nil {
			h.log.Error().Err(err).Msg("Failed to create local track")
			continue
		}

		// Add track to client's PeerConnection
		if _, err := client.PeerConn.AddTrack(localTrack); err != nil {
			h.log.Error().Err(err).Msg("Failed to add track to PeerConnection")
			continue
		}

		// Start forwarding RTP packets
		go h.forwardRTPPackets(client, track, localTrack)
	}
}

func (h *Hub) forwardRTPPackets(client *Client, remoteTrack *webrtc.TrackRemote, localTrack *webrtc.TrackLocalStaticRTP) {
	for {
		packet, _, err := remoteTrack.ReadRTP()
		if err != nil {
			h.log.Debug().Err(err).Msg("Failed to read RTP packet")
			return
		}

		if err := localTrack.WriteRTP(packet); err != nil {
			h.log.Debug().Err(err).Msg("Failed to write RTP packet")
			return
		}
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

	// Close all connections
	h.mu.RLock()
	defer h.mu.RUnlock()

	for _, client := range h.clients {
		if client.PeerConn != nil {
			client.PeerConn.Close()
		}
		client.Conn.Close()
	}
}
