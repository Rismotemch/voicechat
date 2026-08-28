package main

import (
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	
	"github.com/rismotemch/voicechat/internal/config"
	"github.com/rismotemch/voicechat/internal/logger"
	"github.com/rismotemch/voicechat/internal/signaling"
)

func main() {
	// Load configuration
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Failed to load config: %v\n", err)
		os.Exit(1)
	}
	
	// Setup logger
	log := logger.New(cfg.LogLevel, cfg.LogFormat)
	
	// Create signaling hub
	hub := signaling.NewHub(cfg, log)
	
	// Setup routes
	mux := http.NewServeMux()
	
	// WebSocket endpoint
	mux.HandleFunc("/ws", hub.HandleWebSocket)
	
	// Health check
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		fmt.Fprintf(w, `{"status":"ok","users":%d}`, hub.GetRoomUserCount())
	})
	
	// Static files
	fileServer := http.FileServer(http.Dir("./web"))
	mux.Handle("/", fileServer)
	
	// Uploads
	uploadHandler := http.StripPrefix("/uploads/", http.FileServer(http.Dir(cfg.UploadPath)))
	mux.Handle("/uploads/", uploadHandler)
	
	// Start HTTP server
	server := &http.Server{
		Addr:    fmt.Sprintf(":%d", cfg.Port),
		Handler: mux,
	}
	
	// Graceful shutdown
	go func() {
		sigChan := make(chan os.Signal, 1)
		signal.Notify(sigChan, syscall.SIGINT, syscall.SIGTERM)
		<-sigChan
		
		log.Info().Msg("Shutting down server...")
		
		// Close all WebRTC connections
		hub.Close()
		
		if err := server.Close(); err != nil {
			log.Error().Err(err).Msg("Failed to close server")
		}
	}()
	
	log.Info().
		Int("port", cfg.Port).
		Str("domain", cfg.Domain).
		Msg("Server starting")
	
	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatal().Err(err).Msg("Server failed to start")
	}
	
	log.Info().Msg("Server stopped")
}
