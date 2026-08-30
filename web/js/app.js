/**
 * VoiceChat Application - web/js/app.js
 * Multi-room voice chat client with Minecraft 3D telemetry support and host controls.
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

        // Привязка элементов интерфейса
        this.dom = {
            // Лобби
            lobbyScreen: document.getElementById('lobby-screen'),
            usernameInput: document.getElementById('username-input'),
            avatarPreview: document.getElementById('lobby-avatar-preview'),
            roomsContainer: document.getElementById('rooms-list-container'),
            openCreateModalBtn: document.getElementById('open-create-modal-btn'),

            // Модалка создания комнаты
            createModal: document.getElementById('create-room-modal'),
            createNameInput: document.getElementById('create-room-name'),
            createPassInput: document.getElementById('create-room-pass'),
            createMaxSelect: document.getElementById('create-room-max'),
            createMcToggle: document.getElementById('create-room-mc-toggle'),
            cancelCreateBtn: document.getElementById('cancel-create-modal-btn'),
            confirmCreateBtn: document.getElementById('confirm-create-room-btn'),

            // Комната
            roomScreen: document.getElementById('room-screen'),
            roomTitle: document.getElementById('current-room-title'),
            roomMcBadge: document.getElementById('room-mc-badge'),
            roomLockBadge: document.getElementById('room-lock-badge'),
            pingDisplay: document.getElementById('ping-display'),
            leaveRoomBtn: document.getElementById('leave-room-btn'),
            usersList: document.getElementById('users-list'),
            chatMessages: document.getElementById('chat-messages'),
            chatInput: document.getElementById('chat-input'),
            sendChatBtn: document.getElementById('send-chat-btn'),
            micToggleBtn: document.getElementById('mic-toggle-btn'),
            filterSelect: document.getElementById('filter-select'),

            // Панель хоста
            hostControls: document.getElementById('host-controls'),
            hostLockBtn: document.getElementById('host-lock-btn'),
            hostMuteAllBtn: document.getElementById('host-mute-all-btn')
        };
    }

    init() {
        this.setupUserIdentity();
        this.bindEvents();
        this.connectWebSocket();
    }

    setupUserIdentity() {
        let savedName = localStorage.getItem('vc_username') || 'Player_' + Math.floor(Math.random() * 1000);
        this.dom.usernameInput.value = savedName;
        this.updateAvatarPreview(savedName);

        this.currentUser = {
            id: 'u_' + Math.random().toString(36).substring(2, 9),
            name: savedName,
            avatarColor: this.generateAvatarColor(savedName)
        };
    }

    generateAvatarColor(name) {
        const colors = ['#6366f1', '#ec4899', '#8b5cf6', '#10b981', '#f59e0b', '#06b6d4', '#3b82f6'];
        let hash = 0;
        for (let i = 0; i < name.length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
        return colors[Math.abs(hash) % colors.length];
    }

    updateAvatarPreview(name) {
        const initial = (name.trim() || 'U').substring(0, 2).toUpperCase();
        this.dom.avatarPreview.innerText = initial;
        this.dom.avatarPreview.style.background = this.generateAvatarColor(name);
    }

    connectWebSocket() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;

        this.ws = new WebSocket(wsUrl);
        this.ws.binaryType = 'arraybuffer';

        this.ws.onopen = () => {
            console.log('[WebSocket] Connected to Voice Server');
            this.sendJSON('get_rooms', {});
            this.startPingLoop();
        };

        this.ws.onmessage = (event) => {
            if (event.data instanceof ArrayBuffer) {
                this.audio.playAudioPacket(event.data);
            } else {
                try {
                    const msg = JSON.parse(event.data);
                    this.handleSignal(msg);
                } catch (err) {
                    console.error('[WebSocket] JSON parse error:', err);
                }
            }
        };

        this.ws.onclose = () => {
            clearInterval(this.pingInterval);
            setTimeout(() => this.connectWebSocket(), 2000);
        };
    }

    bindEvents() {
        // Профиль
        this.dom.usernameInput.addEventListener('input', (e) => {
            const name = e.target.value.trim() || 'Player';
            this.currentUser.name = name;
            this.currentUser.avatarColor = this.generateAvatarColor(name);
            this.updateAvatarPreview(name);
            localStorage.setItem('vc_username', name);
            if (this.currentRoom) {
                this.sendJSON('update_profile', { userName: name });
            }
        });

        // Модалка создания комнаты
        this.dom.openCreateModalBtn.addEventListener('click', () => {
            this.dom.createNameInput.value = '';
            this.dom.createPassInput.value = '';
            this.dom.createMcToggle.checked = false;
            this.dom.createModal.classList.remove('hidden');
        });

        this.dom.cancelCreateBtn.addEventListener('click', () => {
            this.dom.createModal.classList.add('hidden');
        });

        this.dom.confirmCreateBtn.addEventListener('click', () => {
            const roomName = this.dom.createNameInput.value.trim();
            if (!roomName) return alert('Введите название комнаты');

            this.sendJSON('create_room', {
                roomName: roomName,
                password: this.dom.createPassInput.value.trim(),
                maxUsers: parseInt(this.dom.createMaxSelect.value, 10),
                minecraftMode: this.dom.createMcToggle.checked
            });
            this.dom.createModal.classList.add('hidden');
        });

        // Выход из комнаты
        this.dom.leaveRoomBtn.addEventListener('click', () => this.leaveRoom());

        // Управление микрофоном
        this.dom.micToggleBtn.addEventListener('click', () => {
            const isMuted = this.audio.toggleMute();
            this.dom.micToggleBtn.classList.toggle('danger', isMuted);
            this.dom.micToggleBtn.innerText = isMuted ? 'Включить микрофон' : 'Заглушить микрофон';
            this.sendJSON('mute', { isMuted });
        });

        // DSP Фильтр
        this.dom.filterSelect.addEventListener('change', (e) => {
            this.sendJSON('set_voice_filter', { filter: e.target.value });
        });

        // Чат
        this.dom.sendChatBtn.addEventListener('click', () => this.sendChatMessage());
        this.dom.chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') this.sendChatMessage();
        });

        // Управление хоста
        this.dom.hostLockBtn.addEventListener('click', () => {
            if (!this.currentRoom) return;
            const isLocked = !this.currentRoom.isLocked;
            this.sendJSON('lock_room', { isLocked });
        });

        this.dom.hostMuteAllBtn.addEventListener('click', () => {
            this.sendJSON('mute_all', { isMuted: true });
        });

        // Callback захвата аудиокадра
        this.audio.onAudioFrame = (pcmBuffer) => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN && !this.audio.isMuted) {
                this.ws.send(pcmBuffer);
            }
        };

        // Индикатор говорящего
        this.audio.onSpeakingStateChange = (userId, isSpeaking) => {
            const targetId = userId === 'self' ? this.currentUser?.id : userId;
            const card = document.getElementById(`user-card-${targetId}`);
            if (card) {
                card.classList.toggle('speaking', isSpeaking);
            }
        };
    }

    async joinRoom(roomId, hasPassword) {
        let password = '';
        if (hasPassword) {
            password = prompt('Введите пароль для входа в комнату:');
            if (password === null) return;
        }

        await this.audio.init();
        await this.audio.startMicrophone(false);

        this.sendJSON('join', {
            userId: this.currentUser.id,
            userName: this.currentUser.name,
            avatarColor: this.currentUser.avatarColor,
            roomId: roomId,
            password: password
        });
    }

    leaveRoom() {
        if (!this.currentRoom) return;
        this.sendJSON('leave', { roomId: this.currentRoom.id });
        this.audio.stopMicrophone();

        this.dom.roomScreen.classList.add('hidden');
        this.dom.lobbyScreen.classList.remove('hidden');

        this.users.clear();
        this.currentRoom = null;
        this.spatial = null;
        this.sendJSON('get_rooms', {});
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

            case 'room_created':
                this.sendJSON('get_rooms', {});
                break;

            case 'room_state':
                this.currentRoom = msg.payload;
                this.dom.lobbyScreen.classList.add('hidden');
                this.dom.roomScreen.classList.remove('hidden');

                this.dom.roomTitle.innerText = this.currentRoom.name || 'Комната';
                this.dom.roomMcBadge.classList.toggle('hidden', !this.currentRoom.minecraftMode);
                this.dom.roomLockBadge.classList.toggle('hidden', !this.currentRoom.isLocked);

                // Инициализируем 3D Spatial Engine только если комната с поддержкой MC
                if (this.currentRoom.minecraftMode) {
                    this.spatial = new SpatialAudioEngine(this.audio);
                    this.spatial.init();
                } else {
                    this.spatial = null;
                }

                this.users.clear();
                msg.payload.users.forEach(u => this.users.set(u.id, u));
                this.renderUsers();
                this.updateHostControls();

                this.dom.chatMessages.innerHTML = '';
                if (msg.payload.messages) {
                    msg.payload.messages.forEach(m => this.renderChatMessage(m));
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

            case 'force_mute':
                if (!this.audio.isMuted) {
                    this.audio.toggleMute();
                    this.dom.micToggleBtn.classList.add('danger');
                    this.dom.micToggleBtn.innerText = 'Включить микрофон';
                }
                break;

            case 'host_changed':
                if (this.currentRoom) {
                    this.currentRoom.hostId = msg.payload.hostId;
                    this.updateHostControls();
                }
                break;

            case 'room_locked_updated':
                if (this.currentRoom) {
                    this.currentRoom.isLocked = msg.payload.isLocked;
                    this.dom.roomLockBadge.classList.toggle('hidden', !this.currentRoom.isLocked);
                    this.updateHostControls();
                }
                break;

            case 'chat_message':
                this.renderChatMessage(msg.payload);
                break;

            case 'minecraft_telemetry':
                if (this.currentRoom?.minecraftMode) {
                    this.handleMinecraftTelemetry(msg.payload.players);
                }
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

    handleMinecraftTelemetry(players) {
        if (!this.spatial || !players) return;

        const myName = this.currentUser?.name.toLowerCase();
        let myTelemetry = null;

        for (const p of players) {
            if (p.username.toLowerCase() === myName) {
                myTelemetry = p;
                break;
            }
        }

        if (myTelemetry) {
            this.spatial.updateListener(
                myTelemetry.x,
                myTelemetry.y,
                myTelemetry.z,
                myTelemetry.yaw,
                myTelemetry.pitch,
                myTelemetry.inCave
            );
        }

        for (const p of players) {
            if (p.username.toLowerCase() === myName) continue;

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
        this.dom.roomsContainer.innerHTML = '';
        if (!rooms || rooms.length === 0) {
            this.dom.roomsContainer.innerHTML = '<div style="color: var(--text-muted); grid-column: 1/-1; text-align: center; padding: 2rem;">Нет активных комнат. Создайте первую!</div>';
            return;
        }

        rooms.forEach(room => {
            const userCount = room.users ? Object.keys(room.users).length : 0;
            const card = document.createElement('div');
            card.className = 'room-card';

            let badgesHtml = '';
            if (room.minecraftMode) {
                badgesHtml += `<span class="badge badge-mc">🎮 Minecraft 3D</span>`;
            }
            if (room.hasPassword) {
                badgesHtml += `<span class="badge badge-locked">🔒 С паролем</span>`;
            }

            card.innerHTML = `
                <div class="room-card-header">
                    <div>
                        <div class="room-title">${room.name}</div>
                        <div style="font-size: 0.8rem; color: var(--text-muted); margin-top: 0.25rem;">
                            Участники: ${userCount} / ${room.maxUsers}
                        </div>
                    </div>
                    <div class="room-badges">${badgesHtml}</div>
                </div>
                <button class="join-btn" style="width: 100%;">Войти в комнату</button>
            `;

            card.querySelector('.join-btn').addEventListener('click', () => {
                this.joinRoom(room.id, room.hasPassword);
            });

            this.dom.roomsContainer.appendChild(card);
        });
    }

    renderUsers() {
        this.dom.usersList.innerHTML = '';
        this.users.forEach(u => {
            const card = document.createElement('div');
            card.id = `user-card-${u.id}`;
            card.className = 'user-card';

            const isSelf = u.id === this.currentUser?.id;
            card.innerHTML = `
                <div class="avatar" style="background: ${u.avatarColor || '#6366f1'}">
                    ${u.name.substring(0, 2).toUpperCase()}
                </div>
                <div class="user-meta">
                    <div class="name">${u.name} ${isSelf ? '(Вы)' : ''}</div>
                    <div class="status">${u.isMuted ? '🔇 Заглушен' : '🎙 В эфире'}</div>
                </div>
            `;
            this.dom.usersList.appendChild(card);
        });
    }

    renderChatMessage(msg) {
        const el = document.createElement('div');
        el.className = 'chat-msg';
        el.innerHTML = `
            <div class="chat-msg-header">
                <span class="chat-msg-author">${msg.userName}</span>
                <span>${new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            </div>
            <div>${msg.content}</div>
        `;
        this.dom.chatMessages.appendChild(el);
        this.dom.chatMessages.scrollTop = this.dom.chatMessages.scrollHeight;
    }

    updateHostControls() {
        const isHost = this.currentRoom?.hostId === this.currentUser?.id;
        this.dom.hostControls.classList.toggle('hidden', !isHost);
        if (isHost && this.currentRoom) {
            this.dom.hostLockBtn.innerText = this.currentRoom.isLocked ? 'Разблокировать вход' : 'Заблокировать вход';
        }
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