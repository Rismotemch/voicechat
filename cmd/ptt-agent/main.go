package main

import (
	"crypto/tls"
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
	hook "github.com/robotn/gohook"
)

// Карта физических скан-кодов macOS (не зависят от RU/EN раскладки)
var macKeyCodes = map[string]uint16{
	"a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9,
	"b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19,
	"3": 20, "4": 21, "6": 22, "5": 23, "equal": 24, "9": 25, "7": 26, "minus": 27,
	"8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40,
	"space": 49, "tab": 48, "capslock": 57, "lshift": 56, "lctrl": 59, "lalt": 58,
}

func main() {
	serverAddr := flag.String("server", "voice.repozis.ru", "Адрес сервера VoiceChat")
	username := flag.String("user", "", "Ваш никнейм в голосовом чате (как в браузере)")
	keyName := flag.String("key", "v", "Клавиша Push-to-Talk (v, c, x, space, capslock, lalt)")
	flag.Parse()

	if *username == "" {
		fmt.Println("❌ Ошибка: укажите никнейм: ./ptt-agent -user Rismot3mch -key v")
		os.Exit(1)
	}

	targetKey := strings.ToLower(strings.TrimSpace(*keyName))
	var targetMacRawCode uint16 = 9 // По умолчанию 'v'
	if code, ok := macKeyCodes[targetKey]; ok {
		targetMacRawCode = code
	}

	scheme := "wss"
	host := strings.TrimPrefix(strings.TrimPrefix(*serverAddr, "https://"), "http://")
	if strings.Contains(host, "127.0.0.1") || strings.Contains(host, "localhost") {
		scheme = "ws"
	}

	u := url.URL{Scheme: scheme, Host: host, Path: "/ws"}
	fmt.Printf("🚀 PTT Агент запущен!\n • Сервер: %s\n • Пользователь: %s\n • Клавиша: [%s] (RawCode: %d)\n",
		u.String(), *username, strings.ToUpper(targetKey), targetMacRawCode)
	fmt.Println("💡 Зажатие клавиши работает прямо из Dota 2 / Minecraft в любой раскладке (RU/EN).")

	dialer := websocket.DefaultDialer
	if scheme == "wss" {
		dialer = &websocket.Dialer{
			TLSClientConfig: &tls.Config{InsecureSkipVerify: false},
		}
	}

	conn, _, err := dialer.Dial(u.String(), nil)
	if err != nil {
		fmt.Printf("❌ Не удалось подключиться к серверу: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	// Регистрация
	_ = conn.WriteJSON(map[string]interface{}{
		"type": "ptt_agent_register",
		"payload": map[string]string{
			"userName": *username,
		},
	})

	EvChan := hook.Start()
	defer hook.End()

	isPressed := false
	var lastEventTime time.Time

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)

	for {
		select {
		case ev := <-EvChan:
			isTarget := false

			// Проверка по скан-коду macOS или символу
			if runtime.GOOS == "darwin" {
				if ev.Rawcode == targetMacRawCode {
					isTarget = true
				}
			} else {
				if len(targetKey) == 1 && rune(targetKey[0]) == ev.Keychar {
					isTarget = true
				}
			}

			if !isTarget {
				continue
			}

			// Фильтрация спама повторов ОС (Key Repeat)
			if ev.Kind == hook.KeyDown {
				if !isPressed {
					isPressed = true
					lastEventTime = time.Now()
					_ = conn.WriteJSON(map[string]interface{}{
						"type": "ptt_state",
						"payload": map[string]interface{}{
							"userName":  *username,
							"isPressed": true,
						},
					})
				}
			} else if ev.Kind == hook.KeyUp {
				if isPressed {
					// Анти-дребезг: защита от микро-разрывов
					if time.Since(lastEventTime) < 30*time.Millisecond {
						time.Sleep(30 * time.Millisecond)
					}
					isPressed = false
					_ = conn.WriteJSON(map[string]interface{}{
						"type": "ptt_state",
						"payload": map[string]interface{}{
							"userName":  *username,
							"isPressed": false,
						},
					})
				}
			}

		case <-interrupt:
			fmt.Println("\nОстановка агента...")
			return
		}
	}
}
