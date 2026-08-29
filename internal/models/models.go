package models

import (
	"fmt"
	"sync"
	"time"

	"github.com/google/uuid"
)

type User struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	AvatarColor string    `json:"avatarColor"`
	JoinedAt    time.Time `json:"joinedAt"`
	IsSpeaking  bool      `json:"isSpeaking"`
}

type Room struct {
	mu               sync.RWMutex
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	Users            map[string]*User `json:"users"`
	MaxUsers         int              `json:"maxUsers"`
	Password         string           `json:"password,omitempty"`
	CatInBagMode     bool             `json:"catInBagMode,omitempty"`
	SpatialAudioMode bool             `json:"spatialAudioMode,omitempty"`
	HighQualityMode  bool             `json:"highQualityMode,omitempty"`
	CreatedAt        time.Time        `json:"createdAt"`
}

func NewRoom(name string, maxUsers int) *Room {
	if maxUsers <= 0 {
		maxUsers = 25
	}
	return &Room{
		ID:        uuid.New().String(),
		Name:      name,
		Users:     make(map[string]*User),
		MaxUsers:  maxUsers,
		CreatedAt: time.Now(),
	}
}

func (r *Room) AddUser(user *User) error {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.Users) >= r.MaxUsers {
		return ErrRoomFull
	}

	r.Users[user.ID] = user
	return nil
}

func (r *Room) RemoveUser(userID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Users, userID)
}

func (r *Room) GetUser(userID string) (*User, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	user, exists := r.Users[userID]
	return user, exists
}

func (r *Room) GetUsers() []*User {
	r.mu.RLock()
	defer r.mu.RUnlock()

	users := make([]*User, 0, len(r.Users))
	for _, user := range r.Users {
		users = append(users, user)
	}
	return users
}

func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.Users)
}

var (
	ErrRoomFull = fmt.Errorf("room is full")
)
