# Build stage
FROM golang:1.22-alpine AS builder

WORKDIR /app

# Install build dependencies
RUN apk add --no-cache git

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source code
COPY . .

# Build the application
RUN CGO_ENABLED=0 GOOS=linux go build -a -installsuffix cgo -o voicechat ./cmd/server

# Final stage
FROM alpine:3.18

WORKDIR /app

# Install runtime dependencies
RUN apk add --no-cache ca-certificates tzdata

# Create necessary directories
RUN mkdir -p /app/data/uploads

# Copy binary
COPY --from=builder /app/voicechat /usr/local/bin/voicechat

# Copy static files
COPY web /app/web

# Expose ports
EXPOSE 8080
EXPOSE 50000-50100/udp

# Set environment variables
ENV PORT=8080
ENV ENVIRONMENT=production
ENV LOG_FORMAT=json
ENV UPLOAD_PATH=/app/data/uploads

# Run the application
CMD ["voicechat"]
