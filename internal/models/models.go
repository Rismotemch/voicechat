package models

import (
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultMaxUsers = 10
	MaxAllowedUsers = 10
)

var (
	ErrRoomFull          = errors.New("room is full")
	ErrUserAlreadyExists = errors.New("user already exists in room")
	ErrUserNotFound      = errors.New("user not found")
)

// =============================================================================
// User: Модель участника голосовой комнаты
// =============================================================================

type User struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	AvatarColor string    `json:"avatarColor"`
	JoinedAt    time.Time `json:"joinedAt"`
	IsMuted     bool      `json:"isMuted"`
	IsSpeaking  bool      `json:"isSpeaking"`
}

func NewUser(id, name, avatarColor string) *User {
	return &User{
		ID:          id,
		Name:        name,
		AvatarColor: avatarColor,
		JoinedAt:    time.Now().UTC(),
		IsMuted:     false,
		IsSpeaking:  false,
	}
}

// =============================================================================
// Room: Потокобезопасная сущность комнаты голосового чата
// =============================================================================

type Room struct {
	mu               sync.RWMutex
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	Users            map[string]*User `json:"users"`
	MaxUsers         int              `json:"maxUsers"`
	Password         string           `json:"-"` // Пароль никогда не сериализуется в JSON
	CatInBagMode     bool             `json:"catInBagMode,omitempty"`
	SpatialAudioMode bool             `json:"spatialAudioMode,omitempty"`
	HighQualityMode  bool             `json:"highQualityMode,omitempty"`
	CreatedAt        time.Time        `json:"createdAt"`
}

// NewRoom создает новую изолированную комнату
func NewRoom(name string, maxUsers int) *Room {
	if maxUsers <= 0 || maxUsers > MaxAllowedUsers {
		maxUsers = DefaultMaxUsers
	}

	return &Room{
		ID:        "room_" + uuid.New().String()[:8],
		Name:      name,
		Users:     make(map[string]*User),
		MaxUsers:  maxUsers,
		CreatedAt: time.Now().UTC(),
	}
}

// AddUser добавляет пользователя в комнату с проверкой лимита
func (r *Room) AddUser(user *User) error {
	if user == nil || user.ID == "" {
		return errors.New("invalid user payload")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.Users) >= r.MaxUsers {
		return ErrRoomFull
	}

	r.Users[user.ID] = user
	return nil
}

// RemoveUser удаляет пользователя из комнаты
func (r *Room) RemoveUser(userID string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.Users, userID)
}

// GetUser возвращает копию ссылки на пользователя по ID
func (r *Room) GetUser(userID string) (*User, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	user, exists := r.Users[userID]
	return user, exists
}

// GetUsers возвращает потокобезопасный срез всех текущих участников
func (r *Room) GetUsers() []*User {
	r.mu.RLock()
	defer r.mu.RUnlock()

	users := make([]*User, 0, len(r.Users))
	for _, user := range r.Users {
		users = append(users, user)
	}
	return users
}

// Count возвращает текущее число участников
func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.Users)
}

// HasPassword проверяет, защищена ли комната паролем
func (r *Room) HasPassword() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.Password != ""
}

// VerifyPassword сверяет пароль
func (r *Room) VerifyPassword(password string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.Password == "" {
		return true
	}
	return r.Password == password
}

// MarshalJSON обеспечивает потокобезопасную сериализацию без состояния гонки при чтении map
func (r *Room) MarshalJSON() ([]byte, error) {
	r.mu.RLock()
	defer r.mu.RUnlock()

	type RoomAlias Room
	return json.Marshal(&struct {
		*RoomAlias
		IsProtected bool    `json:"isProtected"`
		UserList    []*User `json:"users"`
	}{
		RoomAlias:   (*RoomAlias)(r),
		IsProtected: r.Password != "",
		UserList:    r.getUsersUnsafe(),
	})
}

// getUsersUnsafe возвращает срез пользователей без захвата мьютекса (для внутренних методов)
func (r *Room) getUsersUnsafe() []*User {
	users := make([]*User, 0, len(r.Users))
	for _, user := range r.Users {
		users = append(users, user)
	}
	return users
}
