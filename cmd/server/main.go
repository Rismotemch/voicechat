package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/logger"
	"github.com/rismotemch/voicechat/internal/signaling"
)

func main() {
	// 1. Загрузка конфигурации окружения
	cfg, err := config.Load()
	if err != nil {
		fmt.Printf("Fatal: failed to load configuration: %v\n", err)
		os.Exit(1)
	}

	// 2. Инициализация структурированного логгера (zerolog)
	log := logger.New(cfg.LogLevel, cfg.LogFormat)
	log.Info().
		Str("environment", cfg.Environment).
		Int("port", cfg.Port).
		Int("maxUsersPerRoom", cfg.MaxUsers).
		Int64("maxUploadSize", cfg.MaxUploadSize).
		Msg("Starting VoiceChat DSP server")

	// 3. Создание директории для загруженных файлов
	if err := os.MkdirAll(cfg.UploadPath, 0755); err != nil {
		log.Fatal().Err(err).Str("uploadPath", cfg.UploadPath).Msg("Failed to create upload directory")
	}

	// 4. Инициализация центрального хаба комнат и DSP-пайплайна
	hub := signaling.NewHub(cfg, log)

	// 5. Настройка HTTP-роутера
	mux := http.NewServeMux()

	// WebSocket аудио и сигнальный эндпоинт
	mux.HandleFunc("/ws", hub.HandleWebSocket)

	// API загрузки файлов и изображений в микро-чат
	mux.HandleFunc("/api/upload", hub.HandleUpload)

	// Раздача сохраненных файлов чата
	uploadsFS := http.FileServer(http.Dir(cfg.UploadPath))
	mux.Handle("/uploads/", http.StripPrefix("/uploads/", uploadsFS))

	// Healthcheck эндпоинт для Docker и мониторинга
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"status":"healthy","users":%d,"timestamp":%d}`, hub.GetRoomUserCount(), time.Now().Unix())
	})

	// Раздача статики веб-клиента с отключением агрессивного кэширования для отладки
	webFS := http.FileServer(http.Dir("./web"))
	mux.Handle("/", staticFilesMiddleware(webFS))

	// 6. Конфигурация HTTP-сервера
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           mux,
		ReadHeaderTimeout: 5 * time.Second,
		IdleTimeout:       120 * time.Second,
	}

	// 7. Запуск сервера в отдельной горутине
	serverErrors := make(chan error, 1)
	go func() {
		log.Info().Str("addr", server.Addr).Msg("HTTP server is listening")
		serverErrors <- server.ListenAndServe()
	}()

	// 8. Перехват сигналов завершения (Graceful Shutdown)
	shutdown := make(chan os.Signal, 1)
	signal.Notify(shutdown, os.Interrupt, syscall.SIGTERM)

	select {
	case err := <-serverErrors:
		if err != nil && err != http.ErrServerClosed {
			log.Fatal().Err(err).Msg("Server crashed unexpectedly")
		}
	case sig := <-shutdown:
		log.Info().Str("signal", sig.String()).Msg("Shutdown signal received, starting graceful termination")

		ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()

		hub.Close()

		if err := server.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("Server forced to shutdown after timeout")
			_ = server.Close()
		}
		log.Info().Msg("Server stopped gracefully")
	}
}

// staticFilesMiddleware добавляет необходимые заголовки для работы PWA и Service Worker
func staticFilesMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")

		if r.URL.Path == "/sw.js" || r.URL.Path == "/" || r.URL.Path == "/index.html" {
			w.Header().Set("Cache-Control", "no-cache, no-store, must-revalidate")
		}

		next.ServeHTTP(w, r)
	})
}
