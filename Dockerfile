# =============================================================================
# Stage 1: Сборка бинарника Go
# =============================================================================
FROM golang:1.26.5-alpine AS builder

WORKDIR /src

# Установка системных утилит сборки и сертификатов
RUN apk add --no-cache git ca-certificates tzdata

# Кэширование зависимостей Go
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Копирование исходного кода
COPY . .

# Сборка статического бинарника без CGO с оптимизацией размера
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -trimpath \
    -ldflags="-s -w -extldflags '-static'" \
    -o /bin/voicechat \
    ./cmd/server

# Создание непривилегированного пользователя для запуска
RUN adduser -D -g '' -u 10001 appuser

# =============================================================================
# Stage 2: Финальный минималистичный Runtime-образ
# =============================================================================
FROM alpine:3.20

WORKDIR /app

# Установка корневых сертификатов TLS и таймзон
RUN apk add --no-cache ca-certificates tzdata curl && \
    mkdir -p /app/data/uploads /app/web

# Копирование пользователя и бинарника из builder-слоя
COPY --from=builder /etc/passwd /etc/passwd
COPY --from=builder /bin/voicechat /usr/local/bin/voicechat

# Копирование статических файлов веб-клиента
COPY web /app/web

# Назначение прав пользователю appuser на рабочую директорию
RUN chown -R appuser:appuser /app

# Переключение на непривилегированного пользователя
USER appuser

# Экспонируем только HTTP/WebSocket порт
EXPOSE 8080

# Переменные окружения по умолчанию
ENV PORT=8080 \
    ENVIRONMENT=production \
    LOG_FORMAT=json \
    LOG_LEVEL=info \
    UPLOAD_PATH=/app/data/uploads \
    AUDIO_SAMPLE_RATE=16000 \
    AUDIO_FRAME_MS=20 \
    MAX_USERS=10

# Проверка работоспособности сервиса
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD curl -f http://127.0.0.1:${PORT}/health || exit 1

# Запуск приложения
ENTRYPOINT ["/usr/local/bin/voicechat"]