package pttagent

import (
	"flag"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strings"
	"syscall"

	"github.com/gorilla/websocket"
	hook "github.com/robotn/gohook"
)

func main() {
	serverAddr := flag.String("server", "localhost:8080", "Адрес сервера VoiceChat")
	username := flag.String("user", "", "Ваш никнейм в голосовом чате (как в браузере)")
	key := flag.String("key", "v", "Клавиша для Push-to-Talk (например: v, space, f1)")
	flag.Parse()

	if *username == "" {
		fmt.Println("❌ Ошибка: укажите ваш никнейм: ./ptt-agent -user Rismot3mch -key v")
		os.Exit(1)
	}

	u := url.URL{Scheme: "ws", Host: *serverAddr, Path: "/ws"}
	fmt.Printf("🚀 PTT Агент запущен! Сервер: %s, Пользователь: %s, Клавиша: [%s]\n", u.String(), *username, strings.ToUpper(*key))
	fmt.Println("💡 Теперь можно свернуть окно и играть в Dota 2 / Minecraft — зажатие клавиши будет работать отовсюду.")

	// Подключение к WebSocket хабу
	conn, _, err := websocket.DefaultDialer.Dial(u.String(), nil)
	if err != nil {
		fmt.Printf("❌ Не удалось подключиться к серверу: %v\n", err)
		os.Exit(1)
	}
	defer conn.Close()

	// Регистрация агента
	_ = conn.WriteJSON(map[string]interface{}{
		"type": "ptt_agent_register",
		"payload": map[string]string{
			"userName": *username,
		},
	})

	targetChar := rune((*key)[0])

	// Запуск глобального перехватчика клавиатуры ОС
	EvChan := hook.Start()
	defer hook.End()

	isPressed := false

	interrupt := make(chan os.Signal, 1)
	signal.Notify(interrupt, os.Interrupt, syscall.SIGTERM)

	for {
		select {
		case ev := <-EvChan:
			if ev.Kind == hook.KeyDown && ev.Keychar == targetChar && !isPressed {
				isPressed = true
				_ = conn.WriteJSON(map[string]interface{}{
					"type": "ptt_state",
					"payload": map[string]interface{}{
						"userName":  *username,
						"isPressed": true,
					},
				})
			} else if ev.Kind == hook.KeyUp && ev.Keychar == targetChar && isPressed {
				isPressed = false
				_ = conn.WriteJSON(map[string]interface{}{
					"type": "ptt_state",
					"payload": map[string]interface{}{
						"userName":  *username,
						"isPressed": false,
					},
				})
			}

		case <-interrupt:
			fmt.Println("\nОстановка агента...")
			return
		}
	}
}
