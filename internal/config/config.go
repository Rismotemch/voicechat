package config

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/joho/godotenv"
)

const (
	DefaultPort            = 8080
	DefaultDomain          = "localhost"
	DefaultEnvironment     = "development"
	DefaultRoomName        = "main"
	DefaultMaxUsers        = 10
	MaxAllowedUsersPerRoom = 10
	DefaultSampleRate      = 16000
	DefaultFrameDurationMs = 20
	DefaultUploadPath      = "./data/uploads"
	DefaultMaxUploadSize   = 50 * 1024 * 1024 // 50 MB
	DefaultLogLevel        = "info"
	DefaultLogFormat       = "console"
)

// Config хранит конфигурацию приложения VoiceChat
type Config struct {
	// Сетевые настройки сервера
	Port        int
	Domain      string
	Environment string // "development" или "production"
	AllowOrigin string

	// Параметры комнат и голосового DSP-ядра
	DefaultRoomName string
	MaxUsers        int // Лимит пользователей на комнату (1-10)
	SampleRate      int // Частота дискретизации DSP (Hz)
	FrameDurationMs int // Длительность аудиофрейма (ms)

	// Безопасность и авторизация
	AuthToken   string
	RequireAuth bool

	// Структурированное логирование (Zerolog)
	LogLevel  string // "debug", "info", "warn", "error"
	LogFormat string // "console" или "json"

	// Хранилище загружаемых файлов
	UploadPath    string
	MaxUploadSize int64
}

// Load загружает и валидирует конфигурацию из .env и переменных окружения
func Load() (*Config, error) {
	// Загружаем .env, если файл присутствует (игнорируем ошибку при отсутствии в проде)
	_ = godotenv.Load()

	maxUsers := getEnvInt("MAX_USERS", DefaultMaxUsers)
	if maxUsers <= 0 || maxUsers > MaxAllowedUsersPerRoom {
		maxUsers = MaxAllowedUsersPerRoom
	}

	uploadPath := filepath.Clean(getEnv("UPLOAD_PATH", DefaultUploadPath))

	cfg := &Config{
		Port:        getEnvInt("PORT", DefaultPort),
		Domain:      getEnv("DOMAIN", DefaultDomain),
		Environment: strings.ToLower(getEnv("ENVIRONMENT", DefaultEnvironment)),
		AllowOrigin: getEnv("ALLOW_ORIGIN", "*"),

		DefaultRoomName: getEnv("DEFAULT_ROOM_NAME", DefaultRoomName),
		MaxUsers:        maxUsers,
		SampleRate:      getEnvInt("AUDIO_SAMPLE_RATE", DefaultSampleRate),
		FrameDurationMs: getEnvInt("AUDIO_FRAME_MS", DefaultFrameDurationMs),

		AuthToken:   getEnv("AUTH_TOKEN", ""),
		RequireAuth: getEnvBool("REQUIRE_AUTH", false),

		LogLevel:  strings.ToLower(getEnv("LOG_LEVEL", DefaultLogLevel)),
		LogFormat: strings.ToLower(getEnv("LOG_FORMAT", DefaultLogFormat)),

		UploadPath:    uploadPath,
		MaxUploadSize: int64(getEnvInt("MAX_UPLOAD_SIZE", DefaultMaxUploadSize)),
	}

	// Валидация критических параметров
	if cfg.Port <= 0 || cfg.Port > 65535 {
		return nil, fmt.Errorf("invalid server port: %d", cfg.Port)
	}

	if cfg.RequireAuth && cfg.AuthToken == "" {
		return nil, errors.New("AUTH_TOKEN must be configured when REQUIRE_AUTH is true")
	}

	// Инициализация директории для загрузок
	if cfg.UploadPath != "" {
		if err := os.MkdirAll(cfg.UploadPath, 0755); err != nil {
			return nil, fmt.Errorf("failed to create upload directory %q: %w", cfg.UploadPath, err)
		}
	}

	return cfg, nil
}

// =============================================================================
// Вспомогательные методы структуры Config
// =============================================================================

func (c *Config) IsProduction() bool {
	return c.Environment == "production"
}

func (c *Config) GetUploadURL() string {
	protocol := "https"
	if !c.IsProduction() && c.Domain == "localhost" {
		protocol = "http"
	}
	return fmt.Sprintf("%s://%s/uploads/", protocol, c.Domain)
}

// =============================================================================
// Внутренние утилиты чтения переменных окружения
// =============================================================================

func getEnv(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		trimmed := strings.TrimSpace(value)
		if trimmed != "" {
			return trimmed
		}
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value, exists := os.LookupEnv(key); exists {
		if intVal, err := strconv.Atoi(strings.TrimSpace(value)); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvBool(key string, defaultValue bool) bool {
	if value, exists := os.LookupEnv(key); exists {
		if boolVal, err := strconv.ParseBool(strings.TrimSpace(value)); err == nil {
			return boolVal
		}
	}
	return defaultValue
}

func getEnvSlice(key string, defaultValue []string) []string {
	if value, exists := os.LookupEnv(key); exists {
		parts := strings.Split(value, ",")
		result := make([]string, 0, len(parts))
		for _, part := range parts {
			trimmed := strings.TrimSpace(part)
			if trimmed != "" {
				result = append(result, trimmed)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return defaultValue
}
