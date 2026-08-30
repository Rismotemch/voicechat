/**
 * VoiceChat Application - web/js/app.js
 * Signaling client, Minecraft telemetry mapper, 3D Spatial Audio bridge, and UI controller.
 */

class VoiceChatApp {
    constructor() {
        this.ws = null;
        this.currentUser = null;
        this.currentRoom = null;
        this.users = new Map(); // userId -> User Object

        this.spatial = null;
        this.audio = window.audioManager;
        this.pingInterval = null;

        // Привязка UI элементов
        this.dom = {
            loginScreen: document.getElementById('login-screen'),
            roomScreen: document.getElementById('room-screen'),
            usernameInput: document.getElementById('username-input'),
            roomSelect: document.getElementById('room-select'),
            roomPasswordInput: document.getElementById('room-password-input'),
            connectBtn: document.getElementById('connect-btn'),
            leaveBtn: document.getElementById('leave-btn'),
            micToggleBtn: document.getElementById('mic-toggle-btn'),
            filterSelect: document.getElementById('filter-select'),
            usersList: document.getElementById('users-list'),
            chatContainer: document.getElementById('chat-messages'),
            chatInput: document.getElementById('chat-input'),
            sendChatBtn: document.getElementById('send-chat-btn'),
            mcStatusBadge: document.getElementById('mc-status-badge'),
            pingDisplay: document.getElementById('ping-display')
        };
    }

    init() {
        this.bindEvents();
        this.connectWebSocket();
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log('[WebSocket] Connected to voice server');
            this.sendJSON('get_rooms', {});
            this.startPingLoop();
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                // Прием сырого PCM аудио-пакета
                this.audio.playAudioPacket(event.data);
            } else {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleSignal(msg);
                } catch (err) {
                    console.error('[WebSocket] Signal parse error:', err);
                }
            }
        };

        this.ws.onclose = () => {
            console.warn('[WebSocket] Connection closed. Reconnecting in 2s...');
            clearInterval(this.pingInterval);
            setTimeout(() => this.connectWebSocket(), 2000);
        };
    }

    bindEvents() {
        this.dom.connectBtn.addEventListener('click', () => this.joinRoom());
        this.dom.leaveBtn.addEventListener('click', () => this.leaveRoom());

        this.dom.micToggleBtn.addEventListener('click', async () => {
            const isMuted = this.audio.toggleMute();
            this.dom.micToggleBtn.classList.toggle('muted', isMuted);
            this.dom.micToggleBtn.innerText = isMuted ? 'Включить микрофон' : 'Заглушить микрофон';
            this.sendJSON('mute', { isMuted });
        });

        this.dom.filterSelect.addEventListener('change', (e) => {
            const filter = e.target.value;
            this.sendJSON('set_voice_filter', { filter });
        });

        this.dom.sendChatBtn.addEventListener('click', () => this.sendChatMessage());
        this.dom.chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendChatMessage();
        });

        // Отправка аудио-кадров из AudioWorklet в WebSocket
        this.audio.onAudioFrame = (pcmBuffer) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.audio.isMuted) {
                this.ws.send(pcmBuffer);
            }
        };

        // Индикация речи участников
        this.audio.onSpeakingStateChange = (userId, isSpeaking) => {
            const targetId = userId === 'self' ? this.currentUser?.id : userId;
            const el = document.getElementById(`user-card-${targetId}`);
            if (el) {
                el.classList.toggle('speaking', isSpeaking);
            }
        };
    }

    async joinRoom() {
        const username = this.dom.usernameInput.value.trim() || 'Player';
        const roomId = this.dom.roomSelect.value;
        const password = this.dom.roomPasswordInput.value.trim();

        // Инициализируем аудио и spatial-движок по жесту пользователя
        await this.audio.init();
        await this.audio.startMicrophone(false);

        this.spatial = new SpatialAudioEngine(this.audio);
        this.spatial.init();

        this.currentUser = {
            id: 'u_' + Math.random().toString(36).substring(2, 9),
            name: username
        };

        this.sendJSON('join', {
            userId: this.currentUser.id,
            userName: this.currentUser.name,
            roomId: roomId,
            password: password
        });
    }

    leaveRoom() {
        this.sendJSON('leave', { roomId: this.currentRoom?.id });
        this.audio.stopMicrophone();
        this.dom.roomScreen.classList.add('hidden');
        this.dom.loginScreen.classList.remove('hidden');
        this.users.clear();
        this.currentRoom = null;
    }

    sendChatMessage() {
        const text = this.dom.chatInput.value.trim();
        if (!text) return;
        this.sendJSON('send_message', { content: text });
        this.dom.chatInput.value = '';
    }

    handleSignal(msg) {
        switch (msg.type) {
            case 'rooms_list':
                this.renderRoomsList(msg.payload.rooms);
                break;

            case 'room_state':
                this.currentRoom = msg.payload;
                this.dom.loginScreen.classList.add('hidden');
                this.dom.roomScreen.classList.remove('hidden');

                this.users.clear();
                msg.payload.users.forEach(u => this.users.set(u.id, u));
                this.renderUsers();

                if (msg.payload.minecraftMode) {
                    this.dom.mcStatusBadge.innerText = 'Minecraft 3D: Активен';
                    this.dom.mcStatusBadge.classList.add('active');
                }
                break;

            case 'user_joined':
                this.users.set(msg.payload.user.id, msg.payload.user);
                this.renderUsers();
                break;

            case 'user_left':
                this.users.delete(msg.payload.userId);
                this.spatial?.removeChain(msg.payload.userId);
                this.renderUsers();
                break;

            case 'user_muted':
                const user = this.users.get(msg.payload.userId);
                if (user) {
                    user.isMuted = msg.payload.isMuted;
                    this.renderUsers();
                }
                break;

            case 'chat_message':
                this.renderChatMessage(msg.payload);
                break;

            case 'minecraft_telemetry':
                this.handleMinecraftTelemetry(msg.payload.players);
                break;

            case 'pong':
                const rtt = Date.now() - msg.payload.clientTimestamp;
                this.dom.pingDisplay.innerText = `${rtt} ms`;
                break;

            case 'error':
                alert(msg.payload.message);
                break;
        }
    }

    /**
     * Сопоставление никнеймов Minecraft с участниками комнаты и передача в Spatial Engine
     */
    handleMinecraftTelemetry(players) {
        if (!this.spatial || !players) return;

        const myName = this.currentUser?.name.toLowerCase();
        let myTelemetry = null;

        // Поиск позиции локального игрока
        for (const p of players) {
            if (p.username.toLowerCase() === myName) {
                myTelemetry = p;
                break;
            }
        }

        if (myTelemetry) {
            // Обновляем координаты и поворот взгляда слушателя
            this.spatial.updateListener(
                myTelemetry.x,
                myTelemetry.y,
                myTelemetry.z,
                myTelemetry.yaw,
                myTelemetry.pitch,
                myTelemetry.inCave
            );
        }

        // Обновляем координаты остальных игроков в 3D пространстве
        for (const p of players) {
            if (p.username.toLowerCase() === myName) continue;

            // Ищем пользователя с таким же именем в веб-комнате
            for (const [userId, user] of this.users.entries()) {
                if (user.name.toLowerCase() === p.username.toLowerCase()) {
                    this.spatial.updateRemotePlayer(
                        userId,
                        p.x,
                        p.y,
                        p.z,
                        p.dimension,
                        p.inCave
                    );
                    break;
                }
            }
        }
    }

    renderRoomsList(rooms) {
        this.dom.roomSelect.innerHTML = '';
        rooms.forEach(room => {
            const opt = document.createElement('option');
            opt.value = room.id;
            opt.innerText = `${room.name} ${room.minecraftMode ? '[MC 3D]' : ''} (${room.users ? Object.keys(room.users).length : 0}/${room.maxUsers})`;
            this.dom.roomSelect.appendChild(opt);
        });
    }

    renderUsers() {
        this.dom.usersList.innerHTML = '';
        this.users.forEach(u => {
            const card = document.createElement('div');
            card.id = `user-card-${u.id}`;
            card.className = 'user-card';
            card.innerHTML = `
                <div class="avatar" style="background: ${u.avatarColor || '#6366f1'}">
                    ${u.name.substring(0, 2).toUpperCase()}
                </div>
                <div class="user-info">
                    <div class="name">${u.name} ${u.id === this.currentUser?.id ? '(Вы)' : ''}</div>
                    <div class="status">${u.isMuted ? 'Заглушен' : 'В эфире'}</div>
                </div>
            `;
            this.dom.usersList.appendChild(card);
        });
    }

    renderChatMessage(msg) {
        const el = document.createElement('div');
        el.className = 'chat-msg';
        el.innerHTML = `<strong>${msg.userName}:</strong> <span>${msg.content}</span>`;
        this.dom.chatContainer.appendChild(el);
        this.dom.chatContainer.scrollTop = this.dom.chatContainer.scrollHeight;
    }

    startPingLoop() {
        this.pingInterval = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.sendJSON('ping', { clientTimestamp: Date.now() });
            }
        }, 3000);
    }

    sendJSON(type, payload) {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type, payload }));
        }
    }
}

window.addEventListener('DOMContentLoaded', () => {
    window.app = new VoiceChatApp();
    window.app.init();
});