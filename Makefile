# ==============================================================================
# VoiceChat Project Makefile
# High-performance server with DSP audio pipeline
# ==============================================================================

BINARY_NAME   ?= voicechat
BUILD_DIR     ?= bin
CMD_DIR       ?= ./cmd/server
DATA_DIR      ?= ./data/uploads

# Go build flags
CGO_ENABLED   ?= 0
LDFLAGS       ?= -s -w -extldflags '-static'
GCFLAGS       ?=

# Docker compose command detection (modern "docker compose" vs legacy "docker-compose")
DOCKER_COMPOSE ?= $(shell which docker-compose 2>/dev/null || echo "docker compose")

.PHONY: all help build build-race run dev test test-race lint fmt tidy docker-build docker-up docker-down docker-logs clean

# Default target
all: build

help:
	@echo "VoiceChat Management Commands:"
	@echo "  make build         - Build optimized production binary ($(BUILD_DIR)/$(BINARY_NAME))"
	@echo "  make build-race    - Build binary with data race detector enabled"
	@echo "  make run           - Run server locally"
	@echo "  make dev           - Run server locally with race detector and debug mode"
	@echo "  make test          - Run unit tests with coverage profile"
	@echo "  make test-race     - Run tests with race detection"
	@echo "  make lint          - Run golangci-lint analysis"
	@echo "  make fmt           - Format Go source code and tidy dependencies"
	@echo "  make tidy          - Download and verify Go modules"
	@echo "  make docker-build  - Build Docker container image"
	@echo "  make docker-up     - Start production Docker container stack in background"
	@echo "  make docker-down   - Stop and remove Docker containers"
	@echo "  make docker-logs   - Follow live container logs"
	@echo "  make clean         - Remove build artifacts and temporary files"

# ------------------------------------------------------------------------------
# Build & Local Development
# ------------------------------------------------------------------------------

build:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=$(CGO_ENABLED) go build \
		-trimpath \
		-ldflags="$(LDFLAGS)" \
		-o $(BUILD_DIR)/$(BINARY_NAME) \
		$(CMD_DIR)
	@echo "✓ Binary successfully built at $(BUILD_DIR)/$(BINARY_NAME)"

build-race:
	@mkdir -p $(BUILD_DIR)
	CGO_ENABLED=1 go build \
		-race \
		-o $(BUILD_DIR)/$(BINARY_NAME)-race \
		$(CMD_DIR)
	@echo "✓ Debug binary with race detector built at $(BUILD_DIR)/$(BINARY_NAME)-race"

run:
	go run $(CMD_DIR)

dev:
	ENVIRONMENT=development LOG_LEVEL=debug go run -race $(CMD_DIR)

# ------------------------------------------------------------------------------
# Testing & Code Quality
# ------------------------------------------------------------------------------

test:
	go test -v -cover -coverprofile=coverage.out ./...

test-race:
	go test -v -race ./...

fmt:
	gofmt -s -w .
	go mod tidy

tidy:
	go mod tidy
	go mod verify

lint:
	@which golangci-lint > /dev/null 2>&1 || (echo "golangci-lint is not installed. Run: go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest" && exit 1)
	golangci-lint run ./...

# ------------------------------------------------------------------------------
# Docker Operations
# ------------------------------------------------------------------------------

docker-build:
	docker build -t voicechat:latest .

docker-up:
	$(DOCKER_COMPOSE) up -d --build

docker-down:
	$(DOCKER_COMPOSE) down

docker-logs:
	$(DOCKER_COMPOSE) logs -f

# ------------------------------------------------------------------------------
# Cleanup
# ------------------------------------------------------------------------------

clean:
	@rm -rf $(BUILD_DIR) coverage.out
	@mkdir -p $(DATA_DIR)
	@find $(DATA_DIR) -mindepth 1 ! -name '.gitkeep' -delete
	@touch $(DATA_DIR)/.gitkeep
	@echo "✓ Clean complete."