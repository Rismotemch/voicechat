package signaling

import (
	"sync"
)

type AudioHub struct {
	mu      sync.RWMutex
	clients map[string]*AudioClient
}

type AudioClient struct {
	ID         string
	UserID     string
	Send       chan []byte
	IsMuted    bool
	IsSpeaking bool
}

func NewAudioHub() *AudioHub {
	return &AudioHub{
		clients: make(map[string]*AudioClient),
	}
}

func (h *AudioHub) AddClient(client *AudioClient) {
	h.mu.Lock()
	defer h.mu.Unlock()
	h.clients[client.ID] = client
}

func (h *AudioHub) RemoveClient(clientID string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	delete(h.clients, clientID)
}

func (h *AudioHub) Broadcast(senderID string, audioData []byte) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	for id, client := range h.clients {
		if id != senderID && !client.IsMuted {
			select {
			case client.Send <- audioData:
			default:
				// Пропускаем, если буфер полон
			}
		}
	}
}

func (h *AudioHub) GetClientCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.clients)
}
