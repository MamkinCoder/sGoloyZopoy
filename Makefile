SHELL := /bin/bash
BIN   := bin/sgz
PI    := rpi-ts
PI_DIR := /opt/sgz
VERSION := $(shell git describe --tags --always --dirty 2>/dev/null || echo dev)
LDFLAGS := -s -w -X main.version=$(VERSION)

.PHONY: all build build-web build-pi test lint run serve deploy sync-data hh-login clean

all: build

build-web:
	cd web && pnpm install --frozen-lockfile && pnpm build

build: build-web
	CGO_ENABLED=0 go build -ldflags '$(LDFLAGS)' -o $(BIN) ./cmd/sgz

build-pi: build-web
	CGO_ENABLED=0 GOOS=linux GOARCH=arm64 go build -ldflags '$(LDFLAGS)' -o bin/sgz-linux-arm64 ./cmd/sgz

test:
	go vet ./... && go test ./...
	cd web && pnpm typecheck

lint:
	go vet ./...

serve:
	go run ./cmd/sgz serve

hh-login:
	go run ./cmd/sgz hh-login --user $(USER)

deploy: build-pi
	ssh $(PI) 'sudo mkdir -p $(PI_DIR)/bin $(PI_DIR)/deploy && sudo chown -R rpi:rpi $(PI_DIR)'
	rsync -az bin/sgz-linux-arm64 $(PI):$(PI_DIR)/bin/sgz.new
	rsync -az deploy/ $(PI):$(PI_DIR)/deploy/
	rsync -az --delete prompts/ $(PI):$(PI_DIR)/prompts/
	rsync -az --delete .claude/ $(PI):$(PI_DIR)/.claude/
	rsync -az CLAUDE.md $(PI):$(PI_DIR)/CLAUDE.md
	ssh $(PI) 'mv $(PI_DIR)/bin/sgz.new $(PI_DIR)/bin/sgz && sudo systemctl restart sgz && sleep 2 && systemctl is-active sgz'

sync-data:
	rsync -az --exclude 'sgz.db*' --exclude 'snapshots/' data/ $(PI):$(PI_DIR)/data/

clean:
	rm -rf bin web/dist
