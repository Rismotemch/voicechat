package logger

import (
	"io"
	"os"
	"strings"
	"time"

	"github.com/rs/zerolog"
)

// New инициализирует и возвращает настроенный экземпляр zerolog.Logger
func New(levelStr, formatStr string) zerolog.Logger {
	// 1. Парсинг уровня логирования с безопасным фоллбэком на Info
	level, err := zerolog.ParseLevel(strings.ToLower(strings.TrimSpace(levelStr)))
	if err != nil {
		level = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(level)

	// 2. Выбор целевого writer'а в зависимости от формата
	var out io.Writer
	format := strings.ToLower(strings.TrimSpace(formatStr))

	if format == "json" {
		out = os.Stdout
	} else {
		// Консольный читаемый вывод с подсветкой синтаксиса для локальной разработки
		out = zerolog.ConsoleWriter{
			Out:        os.Stdout,
			TimeFormat: "15:04:05.000",
			NoColor:    false,
		}
	}

	// 3. Формирование базового контекста логгера
	loggerContext := zerolog.New(out).
		With().
		Timestamp()

	// Включаем указание файла и строки (Caller) для детальной отладки в режиме Debug/Trace
	if level <= zerolog.DebugLevel {
		loggerContext = loggerContext.Caller()
	}

	logger := loggerContext.Logger().Level(level)

	// Стандартизация формата времени в JSON
	zerolog.TimeFieldFormat = time.RFC3339Nano

	return logger
}
