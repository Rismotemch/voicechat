package logger

import (
	"os"
	"time"

	"github.com/rs/zerolog"
)

func New(level string, format string) zerolog.Logger {
	lvl, err := zerolog.ParseLevel(level)
	if err != nil {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)
	
	var output zerolog.ConsoleWriter
	if format == "json" {
		return zerolog.New(os.Stdout).With().Timestamp().Logger()
	}
	
	output = zerolog.ConsoleWriter{
		Out:        os.Stdout,
		TimeFormat: time.RFC3339,
		NoColor:    false,
	}
	
	return zerolog.New(output).With().Timestamp().Logger()
}
