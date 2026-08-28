package signaling

import (
	"net/http"
	"sync"
	
	"github.com/rs/zerolog"
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/models"
)

type Hub struct {
	cfg    *config.Config
	log    zerolog.Logger
	rooms  map[string]*models.Room
	mu     sync.RWMutex
}

func NewHub(cfg *config.Config, log zerolog.Logger) *Hub {
	hub := &Hub{
		cfg:   cfg,
		log:   log,
		rooms: make(map[string]*models.Room),
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
	h.log.Debug().Msg("WebSocket connection attempt")
	// TODO: Implement WebSocket handling
	w.WriteHeader(http.StatusNotImplemented)
}

func (h *Hub) GetRoomUserCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	
	if room, exists := h.rooms[h.cfg.RoomName]; exists {
		return room.Count()
	}
	return 0
}

func (h *Hub) Close() {
	h.log.Info().Msg("Closing signaling hub")
	// TODO: Close all connections
}
