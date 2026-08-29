package models

import (
	"encoding/json"
	"errors"
	"sync"
	"time"

	"github.com/google/uuid"
)

const (
	DefaultMaxUsers        = 10
	MaxAllowedUsersPerRoom = 10
)

var (
	ErrRoomFull          = errors.New("room is full")
	ErrRoomLocked        = errors.New("room is locked by host")
	ErrUserAlreadyExists = errors.New("user already exists in room")
	ErrUserNotFound      = errors.New("user not found")
	ErrUnauthorized      = errors.New("action not permitted: not room host")
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
	IsHost      bool      `json:"isHost"`
	PingMs      int       `json:"pingMs"`
}

func NewUser(id, name, avatarColor string) *User {
	return &User{
		ID:          id,
		Name:        name,
		AvatarColor: avatarColor,
		JoinedAt:    time.Now().UTC(),
		IsMuted:     false,
		IsSpeaking:  false,
		IsHost:      false,
		PingMs:      0,
	}
}

// =============================================================================
// Room: Потокобезопасная сущность комнаты голосового чата
// =============================================================================

type Room struct {
	mu               sync.RWMutex
	ID               string           `json:"id"`
	Name             string           `json:"name"`
	HostID           string           `json:"hostId"`
	IsLocked         bool             `json:"isLocked"`
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
	if maxUsers <= 0 || maxUsers > MaxAllowedUsersPerRoom {
		maxUsers = DefaultMaxUsers
	}

	return &Room{
		ID:        "room_" + uuid.New().String()[:8],
		Name:      name,
		HostID:    "",
		IsLocked:  false,
		Users:     make(map[string]*User),
		MaxUsers:  maxUsers,
		CreatedAt: time.Now().UTC(),
	}
}

// AddUser добавляет пользователя в комнату с проверкой лимита и блокировки
func (r *Room) AddUser(user *User) error {
	if user == nil || user.ID == "" {
		return errors.New("invalid user payload")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	// Проверка на блокировку комнаты
	if r.IsLocked && len(r.Users) > 0 {
		return ErrRoomLocked
	}

	// Проверка лимита мест
	if len(r.Users) >= r.MaxUsers {
		return ErrRoomFull
	}

	// Если хоста еще нет (первый вошедший), назначаем его хостом
	if r.HostID == "" {
		r.HostID = user.ID
		user.IsHost = true
	} else {
		user.IsHost = (r.HostID == user.ID)
	}

	r.Users[user.ID] = user
	return nil
}

// RemoveUser удаляет пользователя и при необходимости передает права хоста следующему
func (r *Room) RemoveUser(userID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.Users, userID)

	// Если комнату покинул хост, выбираем нового среди оставшихся
	var newHostID string
	if r.HostID == userID {
		r.HostID = ""
		for _, remainingUser := range r.Users {
			r.HostID = remainingUser.ID
			remainingUser.IsHost = true
			newHostID = remainingUser.ID
			break
		}
	}

	return newHostID
}

// IsUserHost проверяет, является ли пользователь администратором комнаты
func (r *Room) IsUserHost(userID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.HostID != "" && r.HostID == userID
}

// SetLocked устанавливает статус блокировки входа в комнату
func (r *Room) SetLocked(locked bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.IsLocked = locked
}

// GetUser возвращает копию ссылки на пользователя по ID
func (r *Room) GetUser(userID string) (*User, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	user, exists := r.Users[userID]
	return user, exists
}

// UpdateUserPing обновляет значение задержки участника
func (r *Room) UpdateUserPing(userID string, pingMs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if user, exists := r.Users[userID]; exists {
		user.PingMs = pingMs
	}
}

// GetUsers возвращает срез всех текущих участников
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

func (r *Room) getUsersUnsafe() []*User {
	users := make([]*User, 0, len(r.Users))
	for _, user := range r.Users {
		users = append(users, user)
	}
	return users
}
