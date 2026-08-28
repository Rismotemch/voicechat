package config

import (
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	// Server
	Port       int
	Domain     string
	Environment string // development, production
	
	// Room settings
	RoomName   string
	MaxUsers   int
	
	// WebRTC
	UDPMin     int
	UDPMax     int
	STUNServers []string
	TURNServers []string
	
	// Security
	AuthToken  string
	AllowOrigin string
	
	// Logging
	LogLevel   string
	LogFormat  string // json, console
	
	// Upload
	UploadPath string
	MaxUploadSize int64 // in bytes
}

func Load() (*Config, error) {
	// Load .env if exists
	godotenv.Load()
	
	cfg := &Config{
		Port:        getEnvInt("PORT", 8080),
		Domain:      getEnv("DOMAIN", "localhost"),
		Environment: getEnv("ENVIRONMENT", "development"),
		
		RoomName:    getEnv("ROOM_NAME", "main"),
		MaxUsers:    getEnvInt("MAX_USERS", 50),
		
		UDPMin:      getEnvInt("UDP_MIN", 50000),
		UDPMax:      getEnvInt("UDP_MAX", 50100),
		STUNServers: getEnvSlice("STUN_SERVERS", []string{"stun:stun.l.google.com:19302"}),
		
		AuthToken:   getEnv("AUTH_TOKEN", ""),
		AllowOrigin: getEnv("ALLOW_ORIGIN", "*"),
		
		LogLevel:    getEnv("LOG_LEVEL", "info"),
		LogFormat:   getEnv("LOG_FORMAT", "console"),
		
		UploadPath:  getEnv("UPLOAD_PATH", "./data/uploads"),
		MaxUploadSize: int64(getEnvInt("MAX_UPLOAD_SIZE", 100*1024*1024)), // 100MB default
	}
	
	// Validate
	if cfg.Environment == "production" && cfg.AuthToken == "" {
		return nil, fmt.Errorf("AUTH_TOKEN must be set in production")
	}
	
	// Create upload directory
	if err := os.MkdirAll(cfg.UploadPath, 0755); err != nil {
		return nil, fmt.Errorf("failed to create upload directory: %w", err)
	}
	
	return cfg, nil
}

func getEnv(key, defaultValue string) string {
	if value, exists := os.LookupEnv(key); exists {
		return value
	}
	return defaultValue
}

func getEnvInt(key string, defaultValue int) int {
	if value, exists := os.LookupEnv(key); exists {
		if intVal, err := strconv.Atoi(value); err == nil {
			return intVal
		}
	}
	return defaultValue
}

func getEnvSlice(key string, defaultValue []string) []string {
	if value, exists := os.LookupEnv(key); exists {
		// Простое разделение запятыми
		var result []string
		for _, item := range splitAndTrim(value) {
			if item != "" {
				result = append(result, item)
			}
		}
		if len(result) > 0 {
			return result
		}
	}
	return defaultValue
}

func splitAndTrim(s string) []string {
	var result []string
	start := 0
	for i, ch := range s {
		if ch == ',' {
			if item := trimSpace(s[start:i]); item != "" {
				result = append(result, item)
			}
			start = i + 1
		}
	}
	if item := trimSpace(s[start:]); item != "" {
		result = append(result, item)
	}
	return result
}

func trimSpace(s string) string {
	// Простая реализация trim
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t') {
		s = s[1:]
	}
	for len(s) > 0 && (s[len(s)-1] == ' ' || s[len(s)-1] == '\t') {
		s = s[:len(s)-1]
	}
	return s
}

// Helper methods
func (c *Config) IsProduction() bool {
	return c.Environment == "production"
}

func (c *Config) GetUDPPortRange() string {
	return fmt.Sprintf("%d-%d", c.UDPMin, c.UDPMax)
}

func (c *Config) GetMaxUploadSizeBytes() int64 {
	return c.MaxUploadSize
}

func (c *Config) GetUploadURL() string {
	return fmt.Sprintf("https://%s/uploads/", c.Domain)
}
