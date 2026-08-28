.PHONY: help build run test docker-build docker-up docker-down docker-logs clean

help:
	@echo "Available commands:"
	@echo "  make build         - Build the application"
	@echo "  make run           - Run the application locally"
	@echo "  make test          - Run tests"
	@echo "  make docker-build  - Build Docker image"
	@echo "  make docker-up     - Start Docker containers"
	@echo "  make docker-down   - Stop Docker containers"
	@echo "  make docker-logs   - View Docker logs"
	@echo "  make clean         - Clean build artifacts"

build:
	go build -o bin/voicechat ./cmd/server

run:
	go run ./cmd/server

test:
	go test ./... -v

docker-build:
	docker build -t voicechat:latest .

docker-up:
	docker-compose up -d --build

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f

clean:
	rm -rf bin
	rm -rf data/uploads/*
	touch data/uploads/.gitkeep
