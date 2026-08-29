/**
 * VoiceChat Client Engine - web/js/main.js
 * High-performance WebSocket & UI Controller integrated with AudioManager.
 */

(() => {
    'use strict';

    if (window.voiceChatAppInitialized) {
        console.warn('[VoiceChat] Application already initialized.');
        return;
    }
    window.voiceChatAppInitialized = true;

    // =========================================================================
    // Состояние приложения
    // =========================================================================
    const state = {
        ws: null,
        user: null,
        participants: new Map(), // userId -> { user, card, isSelf }
        isJoined: false,
        isMuted: false,

        // Настройки
        echoCancellationEnabled: true,
        masterVolume: 1.0,

        // Комнаты и навигация
        selectedRoomId: 'main',
        selectedRoomName: 'main',
        currentRoomPassword: null,
        pendingRoomId: null,
        pendingRoomName: null,

        // Соединение
        reconnectAttempts: 0,
        maxReconnectAttempts: 5,
        reconnectTimer: null,
        isConnecting: false
    };

    // =========================================================================
    // Кэш DOM-элементов
    // =========================================================================
    const dom = {
        connectionPanel: document.getElementById('connectionPanel'),
        participantsGrid: document.getElementById('participantsGrid'),
        joinBtn: document.getElementById('joinBtn'),
        micBtn: document.getElementById('micBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        settingsBtn: document.getElementById('settingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn'),
        roomSelectionPanel: document.getElementById('roomSelectionPanel'),
        roomsList: document.getElementById('roomsList'),
        createRoomBtn: document.getElementById('createRoomBtn'),
        refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
        selectedRoomInfo: document.getElementById('selectedRoomInfo'),
        backToRoomsBtn: document.getElementById('backToRoomsBtn'),
        footerControls: document.getElementById('footerControls'),
        currentRoomLabel: document.getElementById('currentRoomLabel'),
        createRoomModal: document.getElementById('createRoomModal'),
        confirmCreateRoomBtn: document.getElementById('confirmCreateRoomBtn'),
        cancelCreateRoomBtn: document.getElementById('cancelCreateRoomBtn'),
        passwordModal: document.getElementById('passwordModal'),
        confirmPasswordBtn: document.getElementById('confirmPasswordBtn'),
        cancelPasswordBtn: document.getElementById('cancelPasswordBtn'),
        settingsUserName: document.getElementById('settingsUserName'),
        masterVolume: document.getElementById('masterVolume'),
        masterVolumeValue: document.getElementById('masterVolumeValue'),
        echoCancellation: document.getElementById('echoCancellation'),
        roomNameInput: document.getElementById('roomNameInput'),
        roomPasswordInput: document.getElementById('roomPasswordInput'),
        roomMaxUsersInput: document.getElementById('roomMaxUsersInput'),
        roomPasswordCheckInput: document.getElementById('roomPasswordCheckInput')
    };

    // =========================================================================
    // Инициализация
    // =========================================================================
    document.addEventListener('DOMContentLoaded', () => {
        initUserProfile();
        bindUIEvents();
        setupAudioCallbacks();
        showRoomSelectionView();
    });

    function initUserProfile() {
        let name = localStorage.getItem('voicechat_username');
        if (!name || !name.trim()) {
            name = 'Гость ' + Math.floor(100 + Math.random() * 900);
            localStorage.setItem('voicechat_username', name);
        }
        state.user = {
            id: 'u_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).slice(-4),
            name: name.trim(),
            avatarColor: getRandomAvatarColor()
        };

        if (dom.settingsUserName) {
            dom.settingsUserName.value = state.user.name;
        }
    }

    function setupAudioCallbacks() {
        // 1. Отправка исходящих квантов аудио (20ms PCM16) в WebSocket
        window.audioManager.onAudioFrame = (pcmBuffer) => {
            if (state.isJoined && !state.isMuted && state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(pcmBuffer);
            }
        };

        // 2. Отображение индикаторов активности голоса (VAD)
        window.audioManager.onSpeakingStateChange = (userId, isSpeaking) => {
            const targetId = userId === 'self' && state.user ? state.user.id : userId;
            updateSpeakingUI(targetId, isSpeaking);
        };
    }

    function bindUIEvents() {
        if (dom.joinBtn) dom.joinBtn.addEventListener('click', () => joinRoom());
        if (dom.micBtn) dom.micBtn.addEventListener('click', () => toggleMute());
        if (dom.leaveBtn) dom.leaveBtn.addEventListener('click', () => leaveRoom());
        if (dom.settingsBtn) dom.settingsBtn.addEventListener('click', () => openSettingsModal());
        if (dom.closeSettingsBtn) dom.closeSettingsBtn.addEventListener('click', () => saveSettings());
        if (dom.createRoomBtn) dom.createRoomBtn.addEventListener('click', () => openCreateRoomModal());
        if (dom.refreshRoomsBtn) dom.refreshRoomsBtn.addEventListener('click', () => requestRoomsList());
        if (dom.backToRoomsBtn) dom.backToRoomsBtn.addEventListener('click', () => showRoomSelectionView());
        if (dom.confirmCreateRoomBtn) dom.confirmCreateRoomBtn.addEventListener('click', () => handleCreateRoomSubmit());
        if (dom.cancelCreateRoomBtn) dom.cancelCreateRoomBtn.addEventListener('click', () => closeCreateRoomModal());
        if (dom.confirmPasswordBtn) dom.confirmPasswordBtn.addEventListener('click', () => handlePasswordSubmit());
        if (dom.cancelPasswordBtn) dom.cancelPasswordBtn.addEventListener('click', () => closePasswordModal());

        if (dom.masterVolume) {
            dom.masterVolume.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                if (dom.masterVolumeValue) dom.masterVolumeValue.textContent = `${val}%`;
                state.masterVolume = val / 100;
                window.audioManager.setMasterVolume(state.masterVolume);
            });
        }
    }

    // =========================================================================
    // WebSocket Transport
    // =========================================================================
    function getWebSocketURL() {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        return `${protocol}//${window.location.host}/ws`;
    }

    async function connectWebSocket() {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            return Promise.resolve();
        }

        if (state.isConnecting) {
            return new Promise((resolve) => {
                const interval = setInterval(() => {
                    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                        clearInterval(interval);
                        resolve();
                    }
                }, 50);
            });
        }

        state.isConnecting = true;

        return new Promise((resolve, reject) => {
            try {
                if (state.ws) {
                    state.ws.onopen = null;
                    state.ws.onmessage = null;
                    state.ws.onerror = null;
                    state.ws.onclose = null;
                    state.ws.close();
                }

                state.ws = new WebSocket(getWebSocketURL());
                state.ws.binaryType = 'arraybuffer';

                state.ws.onopen = () => {
                    state.isConnecting = false;
                    state.reconnectAttempts = 0;
                    if (state.reconnectTimer) {
                        clearTimeout(state.reconnectTimer);
                        state.reconnectTimer = null;
                    }
                    resolve();
                };

                state.ws.onmessage = (event) => {
                    if (typeof event.data === 'string') {
                        handleSignalingMessage(event.data);
                    } else if (event.data instanceof ArrayBuffer) {
                        // Воспроизведение обработанного сервером аудио с выравниванием и джиттер-буфером
                        window.audioManager.playAudioPacket(event.data);
                    }
                };

                state.ws.onerror = (err) => {
                    console.error('[VoiceChat] WebSocket transport error:', err);
                };

                state.ws.onclose = (event) => {
                    state.isConnecting = false;
                    state.ws = null;
                    handleConnectionClose(event);
                };
            } catch (err) {
                state.isConnecting = false;
                reject(err);
            }
        });
    }

    function handleConnectionClose() {
        if (!state.isJoined) return;

        if (state.reconnectAttempts < state.maxReconnectAttempts) {
            state.reconnectAttempts++;
            const timeout = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 5000);
            console.warn(`[VoiceChat] Reconnecting in ${Math.round(timeout)}ms...`);

            state.reconnectTimer = setTimeout(async () => {
                try {
                    await connectWebSocket();
                    sendJoinPayload();
                } catch (e) { }
            }, timeout);
        } else {
            alert('Связь с сервером потеряна.');
            leaveRoom();
        }
    }

    function sendSignaling(type, payload = {}) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type, payload }));
        }
    }

    // =========================================================================
    // Signaling Handler
    // =========================================================================
    function handleSignalingMessage(jsonString) {
        try {
            const msg = JSON.parse(jsonString);
            switch (msg.type) {
                case 'room_state':
                    onRoomState(msg.payload);
                    break;
                case 'user_joined':
                    onUserJoined(msg.payload);
                    break;
                case 'user_left':
                    onUserLeft(msg.payload);
                    break;
                case 'user_muted':
                    onUserMuted(msg.payload);
                    break;
                case 'user_updated':
                    onUserUpdated(msg.payload);
                    break;
                case 'room_created':
                    onRoomCreated(msg.payload);
                    break;
                case 'rooms_list':
                    onRoomsList(msg.payload);
                    break;
                case 'error':
                    onServerError(msg.payload);
                    break;
            }
        } catch (err) {
            console.error('[VoiceChat] Error parsing signaling payload:', err);
        }
    }

    function onRoomState(payload) {
        clearParticipantsUI();
        if (Array.isArray(payload.users)) {
            payload.users.forEach(u => {
                const isSelf = Boolean(state.user && u.id === state.user.id);
                addParticipantToUI(u, isSelf);
            });
        }

        state.isJoined = true;
        dom.connectionPanel.style.display = 'none';
        dom.participantsGrid.style.display = 'grid';
        dom.footerControls.style.display = 'flex';
        updateRoomLabel();
    }

    function onUserJoined(payload) {
        if (payload.user && (!state.user || payload.user.id !== state.user.id)) {
            addParticipantToUI(payload.user, false);
        }
    }

    function onUserLeft(payload) {
        if (payload.userId) {
            removeParticipantFromUI(payload.userId);
            window.audioManager.removeParticipant(payload.userId);
        }
    }

    function onUserMuted(payload) {
        const card = document.getElementById(`participant-${payload.userId}`);
        if (card) {
            card.classList.toggle('muted', Boolean(payload.isMuted));
        }
    }

    function onUserUpdated(payload) {
        if (!payload.user) return;
        const card = document.getElementById(`participant-${payload.user.id}`);
        if (card) {
            const nameEl = card.querySelector('.participant-name');
            if (nameEl) {
                const isSelf = state.user && payload.user.id === state.user.id;
                nameEl.textContent = isSelf ? `${payload.user.name} (Вы)` : payload.user.name;
            }
        }
    }

    function onRoomCreated(payload) {
        if (payload.room) {
            state.selectedRoomId = payload.room.id;
            state.selectedRoomName = payload.room.name;
            state.currentRoomPassword = payload.room.password || null;
            updateRoomLabel();
            requestRoomsList();
            selectRoom(state.selectedRoomId, state.selectedRoomName);
        }
    }

    function onRoomsList(payload) {
        if (!dom.roomsList || !Array.isArray(payload.rooms)) return;
        dom.roomsList.innerHTML = '';

        payload.rooms.forEach(room => {
            const card = document.createElement('div');
            card.className = 'room-card';

            const info = document.createElement('div');
            info.className = 'room-card-info';

            const name = document.createElement('div');
            name.className = 'room-card-name';
            name.textContent = room.name;

            const users = document.createElement('div');
            users.className = 'room-card-users';
            const count = Array.isArray(room.users) ? room.users.length : (room.users ? Object.keys(room.users).length : 0);
            const max = room.maxUsers || 10;
            users.textContent = `👥 ${count} / ${max}`;

            info.appendChild(name);
            info.appendChild(users);

            const lock = document.createElement('span');
            lock.className = 'room-card-lock';
            lock.textContent = room.isProtected || room.password ? '🔒' : '';

            card.appendChild(info);
            card.appendChild(lock);

            card.addEventListener('click', () => {
                if (room.isProtected || room.password) {
                    openPasswordModal(room.id, room.name);
                } else {
                    selectRoom(room.id, room.name);
                }
            });

            dom.roomsList.appendChild(card);
        });
    }

    function onServerError(payload) {
        const message = payload && payload.message ? payload.message : 'Неизвестная ошибка';
        alert(`Ошибка: ${message}`);
        showRoomSelectionView();
    }

    // =========================================================================
    // UI & Управление вызовами
    // =========================================================================
    async function joinRoom() {
        if (!state.user) initUserProfile();

        // 1. Инициализация и захват аудио прямо по клику (разблокировка Autoplay Policy)
        try {
            await window.audioManager.init();
            await window.audioManager.startMicrophone(state.echoCancellationEnabled);
        } catch (err) {
            console.error('[VoiceChat] Microphone permission denied or failed:', err);
            alert('Не удалось получить доступ к микрофону. Проверьте разрешения в браузере.');
            return;
        }

        // 2. Подключение к WebSocket и вход в комнату
        try {
            await connectWebSocket();
            sendJoinPayload();
        } catch (err) {
            alert('Не удалось подключиться к серверу голосового чата.');
        }
    }

    function sendJoinPayload() {
        const payload = {
            userId: state.user.id,
            userName: state.user.name,
            avatarColor: state.user.avatarColor,
            roomId: state.selectedRoomId
        };
        if (state.currentRoomPassword) {
            payload.password = state.currentRoomPassword;
        }
        sendSignaling('join', payload);
    }

    function leaveRoom() {
        if (state.isJoined) {
            sendSignaling('leave', { roomId: state.selectedRoomId });
        }

        window.audioManager.stopMicrophone();
        state.isJoined = false;
        clearParticipantsUI();

        dom.participantsGrid.style.display = 'none';
        dom.footerControls.style.display = 'none';
        showRoomSelectionView();
    }

    function toggleMute() {
        state.isMuted = window.audioManager.toggleMute();
        sendSignaling('mute', { isMuted: state.isMuted });

        if (dom.micBtn) {
            dom.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
            dom.micBtn.classList.toggle('muted-active', state.isMuted);
        }
        if (state.user) {
            const myCard = document.getElementById(`participant-${state.user.id}`);
            if (myCard) myCard.classList.toggle('muted', state.isMuted);
        }
    }

    function showRoomSelectionView() {
        closeCreateRoomModal();
        closePasswordModal();
        window.audioManager.stopMicrophone();

        state.isJoined = false;
        clearParticipantsUI();

        dom.roomSelectionPanel.style.display = 'block';
        dom.connectionPanel.style.display = 'none';
        dom.participantsGrid.style.display = 'none';
        dom.footerControls.style.display = 'none';

        state.selectedRoomId = 'main';
        state.selectedRoomName = 'main';
        state.currentRoomPassword = null;
        updateRoomLabel();
        requestRoomsList();
    }

    function selectRoom(roomId, roomName) {
        state.selectedRoomId = roomId;
        state.selectedRoomName = roomName;
        updateRoomLabel();

        dom.roomSelectionPanel.style.display = 'none';
        dom.connectionPanel.style.display = 'block';

        if (dom.selectedRoomInfo) {
            dom.selectedRoomInfo.innerHTML = `<strong>Комната:</strong> ${escapeHTML(roomName)}<br><small>Готов к подключению</small>`;
        }
    }

    function updateRoomLabel() {
        if (!dom.currentRoomLabel) return;
        dom.currentRoomLabel.textContent = state.isJoined
            ? `Комната: ${state.selectedRoomName}`
            : (state.selectedRoomName !== 'main' ? `Комната: ${state.selectedRoomName}` : 'Выберите комнату');
    }

    function openSettingsModal() {
        if (dom.settingsUserName && state.user) {
            dom.settingsUserName.value = state.user.name;
        }
        if (dom.echoCancellation) {
            dom.echoCancellation.checked = state.echoCancellationEnabled;
        }
        if (dom.settingsModal) {
            dom.settingsModal.style.display = 'flex';
        }
    }

    function saveSettings() {
        if (dom.settingsUserName) {
            const newName = dom.settingsUserName.value.trim();
            if (newName && state.user && newName !== state.user.name) {
                state.user.name = newName;
                localStorage.setItem('voicechat_username', newName);
                if (state.isJoined) {
                    sendSignaling('update_profile', { userName: newName });
                }
            }
        }

        if (dom.echoCancellation) {
            const prev = state.echoCancellationEnabled;
            state.echoCancellationEnabled = dom.echoCancellation.checked;
            if (prev !== state.echoCancellationEnabled && state.isJoined) {
                window.audioManager.startMicrophone(state.echoCancellationEnabled).catch(console.error);
            }
        }

        if (dom.settingsModal) {
            dom.settingsModal.style.display = 'none';
        }
    }

    function openCreateRoomModal() {
        if (dom.createRoomModal) dom.createRoomModal.style.display = 'flex';
    }

    function closeCreateRoomModal() {
        if (dom.createRoomModal) dom.createRoomModal.style.display = 'none';
    }

    async function handleCreateRoomSubmit() {
        const roomName = dom.roomNameInput ? dom.roomNameInput.value.trim() : '';
        if (!roomName) {
            alert('Введите название комнаты');
            return;
        }

        const password = dom.roomPasswordInput ? dom.roomPasswordInput.value : '';
        const maxUsers = dom.roomMaxUsersInput ? parseInt(dom.roomMaxUsersInput.value, 10) || 10 : 10;

        const payload = {
            roomName,
            maxUsers: Math.min(10, Math.max(2, maxUsers))
        };
        if (password) payload.password = password;

        try {
            await connectWebSocket();
            sendSignaling('create_room', payload);
            closeCreateRoomModal();
            if (dom.roomNameInput) dom.roomNameInput.value = '';
            if (dom.roomPasswordInput) dom.roomPasswordInput.value = '';
        } catch (err) {
            console.error('[VoiceChat] Create room failed:', err);
        }
    }

    function openPasswordModal(roomId, roomName) {
        state.pendingRoomId = roomId;
        state.pendingRoomName = roomName;
        if (dom.passwordModal) dom.passwordModal.style.display = 'flex';
        if (dom.roomPasswordCheckInput) {
            dom.roomPasswordCheckInput.value = '';
            dom.roomPasswordCheckInput.focus();
        }
    }

    function closePasswordModal() {
        if (dom.passwordModal) dom.passwordModal.style.display = 'none';
        state.pendingRoomId = null;
        state.pendingRoomName = null;
    }

    function handlePasswordSubmit() {
        if (!dom.roomPasswordCheckInput) return;
        const password = dom.roomPasswordCheckInput.value;
        if (state.pendingRoomId) {
            state.selectedRoomId = state.pendingRoomId;
            state.selectedRoomName = state.pendingRoomName;
            state.currentRoomPassword = password;
            selectRoom(state.selectedRoomId, state.selectedRoomName);
        }
        closePasswordModal();
    }

    async function requestRoomsList() {
        try {
            await connectWebSocket();
            sendSignaling('get_rooms', {});
        } catch (err) { }
    }

    // =========================================================================
    // Карточки участников
    // =========================================================================
    function addParticipantToUI(user, isSelf = false) {
        if (!user || !user.id || state.participants.has(user.id)) return;

        const card = document.createElement('div');
        card.className = 'participant-card glass';
        card.id = `participant-${user.id}`;

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.background = user.avatarColor || getRandomAvatarColor();
        avatar.textContent = (user.name || 'U').charAt(0).toUpperCase();

        const name = document.createElement('div');
        name.className = 'participant-name';
        name.textContent = isSelf ? `${user.name} (Вы)` : user.name;

        card.appendChild(avatar);
        card.appendChild(name);

        if (!isSelf) {
            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.min = '0';
            volSlider.max = '200';
            volSlider.value = '100';
            volSlider.className = 'volume-control';
            volSlider.title = 'Громкость собеседника';

            volSlider.addEventListener('input', (e) => {
                const gain = parseInt(e.target.value, 10) / 100;
                window.audioManager.setParticipantVolume(user.id, gain);
            });
            card.appendChild(volSlider);
        }

        if (dom.participantsGrid) {
            dom.participantsGrid.appendChild(card);
        }

        state.participants.set(user.id, { user, card, isSelf });
    }

    function removeParticipantFromUI(userId) {
        const participant = state.participants.get(userId);
        if (participant && participant.card) {
            participant.card.remove();
            state.participants.delete(userId);
        }
    }

    function clearParticipantsUI() {
        state.participants.clear();
        if (dom.participantsGrid) {
            dom.participantsGrid.innerHTML = '';
        }
    }

    function updateSpeakingUI(userId, isSpeaking) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            card.classList.toggle('speaking', Boolean(isSpeaking));
        }
    }

    function getRandomAvatarColor() {
        const palette = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b', '#20c997', '#f06595'];
        return palette[Math.floor(Math.random() * palette.length)];
    }

    function escapeHTML(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();