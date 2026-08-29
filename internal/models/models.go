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
	MaxChatHistory         = 50 // Лимит хранения сообщений в оперативной памяти комнаты
)

var (
	ErrRoomFull          = errors.New("room is full")
	ErrRoomLocked        = errors.New("room is locked by host")
	ErrUserAlreadyExists = errors.New("user already exists in room")
	ErrUserNotFound      = errors.New("user not found")
	ErrUnauthorized      = errors.New("action not permitted: not room host")
)

// =============================================================================
// ChatMessage: Модель текстового сообщения и обмена файлами
// =============================================================================

type ChatMessage struct {
	ID          string    `json:"id"`
	RoomID      string    `json:"roomId"`
	UserID      string    `json:"userId"`
	UserName    string    `json:"userName"`
	AvatarColor string    `json:"avatarColor"`
	Content     string    `json:"content,omitempty"`
	FileURL     string    `json:"fileUrl,omitempty"`
	FileName    string    `json:"fileName,omitempty"`
	FileSize    int64     `json:"fileSize,omitempty"`
	FileType    string    `json:"fileType,omitempty"` // "text", "image", "audio", "file"
	Timestamp   time.Time `json:"timestamp"`
}

func NewChatMessage(roomID, userID, userName, avatarColor, content string) *ChatMessage {
	return &ChatMessage{
		ID:          "msg_" + uuid.New().String()[:8],
		RoomID:      roomID,
		UserID:      userID,
		UserName:    userName,
		AvatarColor: avatarColor,
		Content:     content,
		FileType:    "text",
		Timestamp:   time.Now().UTC(),
	}
}

func NewFileChatMessage(roomID, userID, userName, avatarColor, fileURL, fileName, fileType string, fileSize int64) *ChatMessage {
	return &ChatMessage{
		ID:          "msg_" + uuid.New().String()[:8],
		RoomID:      roomID,
		UserID:      userID,
		UserName:    userName,
		AvatarColor: avatarColor,
		FileURL:     fileURL,
		FileName:    fileName,
		FileSize:    fileSize,
		FileType:    fileType,
		Timestamp:   time.Now().UTC(),
	}
}

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
	VoiceFilter string    `json:"voiceFilter"` // "none", "radio", "robot", "megaphone", "demon"
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
		VoiceFilter: "none",
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
	Messages         []*ChatMessage   `json:"messages"`
	MaxUsers         int              `json:"maxUsers"`
	Password         string           `json:"-"`
	CatInBagMode     bool             `json:"catInBagMode,omitempty"`
	SpatialAudioMode bool             `json:"spatialAudioMode,omitempty"`
	HighQualityMode  bool             `json:"highQualityMode,omitempty"`
	CreatedAt        time.Time        `json:"createdAt"`
}

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
		Messages:  make([]*ChatMessage, 0, MaxChatHistory),
		MaxUsers:  maxUsers,
		CreatedAt: time.Now().UTC(),
	}
}

// AddUser добавляет пользователя в комнату
func (r *Room) AddUser(user *User) error {
	if user == nil || user.ID == "" {
		return errors.New("invalid user payload")
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	if r.IsLocked && len(r.Users) > 0 {
		return ErrRoomLocked
	}

	if len(r.Users) >= r.MaxUsers {
		return ErrRoomFull
	}

	if r.HostID == "" {
		r.HostID = user.ID
		user.IsHost = true
	} else {
		user.IsHost = (r.HostID == user.ID)
	}

	r.Users[user.ID] = user
	return nil
}

// RemoveUser удаляет пользователя и передает права хоста при необходимости
func (r *Room) RemoveUser(userID string) string {
	r.mu.Lock()
	defer r.mu.Unlock()

	delete(r.Users, userID)

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

// AddMessage добавляет сообщение в кольцевой буфер истории чата
func (r *Room) AddMessage(msg *ChatMessage) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if len(r.Messages) >= MaxChatHistory {
		r.Messages = r.Messages[1:]
	}
	r.Messages = append(r.Messages, msg)
}

// GetMessages возвращает копию среза сообщений чата
func (r *Room) GetMessages() []*ChatMessage {
	r.mu.RLock()
	defer r.mu.RUnlock()

	history := make([]*ChatMessage, len(r.Messages))
	copy(history, r.Messages)
	return history
}

// SetUserVoiceFilter обновляет текущий активный DSP-фильтр пользователя
func (r *Room) SetUserVoiceFilter(userID, filter string) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if user, exists := r.Users[userID]; exists {
		user.VoiceFilter = filter
	}
}

// IsUserHost проверяет, является ли пользователь создателем/хостом
func (r *Room) IsUserHost(userID string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.HostID != "" && r.HostID == userID
}

// SetLocked блокирует или разблокирует вход в комнату
func (r *Room) SetLocked(locked bool) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.IsLocked = locked
}

// GetUser возвращает пользователя по ID
func (r *Room) GetUser(userID string) (*User, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	user, exists := r.Users[userID]
	return user, exists
}

// UpdateUserPing обновляет пинг участника
func (r *Room) UpdateUserPing(userID string, pingMs int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	if user, exists := r.Users[userID]; exists {
		user.PingMs = pingMs
	}
}

// GetUsers возвращает срез всех участников
func (r *Room) GetUsers() []*User {
	r.mu.RLock()
	defer r.mu.RUnlock()

	users := make([]*User, 0, len(r.Users))
	for _, user := range r.Users {
		users = append(users, user)
	}
	return users
}

// Count возвращает количество участников
func (r *Room) Count() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.Users)
}

// HasPassword проверяет наличие пароля
func (r *Room) HasPassword() bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return r.Password != ""
}

// VerifyPassword проверяет валидность пароля
func (r *Room) VerifyPassword(password string) bool {
	r.mu.RLock()
	defer r.mu.RUnlock()
	if r.Password == "" {
		return true
	}
	return r.Password == password
}

// MarshalJSON потокобезопасно сериализует комнату
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
