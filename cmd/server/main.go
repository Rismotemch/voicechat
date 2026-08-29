package main

import (
	"context"
	"errors"
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

const (
	shutdownTimeout   = 10 * time.Second
	readHeaderTimeout = 5 * time.Second
	idleTimeout       = 120 * time.Second
)

func main() {
	// 1. Загрузка конфигурации
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "FATAL: Failed to load config: %v\n", err)
		os.Exit(1)
	}

	// 2. Инициализация структурированного логгера
	log := logger.New(cfg.LogLevel, cfg.LogFormat)

	log.Info().
		Str("environment", cfg.Environment).
		Int("port", cfg.Port).
		Str("domain", cfg.Domain).
		Msg("Initializing VoiceChat Server Engine...")

	// 3. Создание сигнального и аудио-маршрутизатора
	hub := signaling.NewHub(cfg, log)

	// 4. Настройка HTTP-роутера
	mux := http.NewServeMux()

	// WebSocket аудио и сигнальный эндпоинт
	mux.HandleFunc("/ws", hub.HandleWebSocket)

	// Health Check / Метрики
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"status":"healthy","users":%d}`, hub.GetRoomUserCount())
	})

	// Статические файлы веб-интерфейса
	fs := http.FileServer(http.Dir("./web"))
	mux.Handle("/", staticFilesMiddleware(fs))

	// Раздача загруженных файлов (если используется путь аватарок/файлов)
	if cfg.UploadPath != "" {
		if _, err := os.Stat(cfg.UploadPath); os.IsNotExist(err) {
			_ = os.MkdirAll(cfg.UploadPath, 0755)
		}
		uploadFS := http.StripPrefix("/uploads/", http.FileServer(http.Dir(cfg.UploadPath)))
		mux.Handle("/uploads/", uploadFS)
	}

	// 5. Конфигурация HTTP-сервера
	server := &http.Server{
		Addr:              fmt.Sprintf(":%d", cfg.Port),
		Handler:           mux,
		ReadHeaderTimeout: readHeaderTimeout,
		IdleTimeout:       idleTimeout,
	}

	// 6. Graceful Shutdown канал
	shutdownComplete := make(chan struct{})

	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigChan

		log.Info().Str("signal", sig.String()).Msg("Received termination signal, shutting down gracefully...")

		ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
		defer cancel()

		// Остановка приема новых входящих HTTP/WS подключений
		if err := server.Shutdown(ctx); err != nil {
			log.Error().Err(err).Msg("HTTP server shutdown encountered an error")
		}

		// Корректное закрытие активных аудиосессий и каналов горутин
		hub.Close()

		close(shutdownComplete)
	}()

	// 7. Запуск сервера
	log.Info().
		Int("port", cfg.Port).
		Str("ws_endpoint", fmt.Sprintf("ws://%s:%d/ws", cfg.Domain, cfg.Port)).
		Msg("VoiceChat Server successfully started")

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal().Err(err).Msg("Server crashed unexpectedly")
	}

	<-shutdownComplete
	log.Info().Msg("Server stopped completely. Goodbye.")
}

// staticFilesMiddleware добавляет базовые заголовки безопасности и отключает кэш для JS/Worklet файлов в разработке
func staticFilesMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("X-Frame-Options", "DENY")
		w.Header().Set("X-XSS-Protection", "1; mode=block")

		// Для корректной работы AudioWorklet без кэширования старых скриптов браузером
		if len(r.URL.Path) >= 3 && r.URL.Path[len(r.URL.Path)-3:] == ".js" {
			w.Header().Set("Cache-Control", "no-cache, must-revalidate")
		}

		next.ServeHTTP(w, r)
	})
}
