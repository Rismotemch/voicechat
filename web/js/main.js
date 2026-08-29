/**
 * VoiceChat Client Engine - web/js/main.js
 * Integrated with Host Controls, Ping/Telemetry, Live Visualizer & Invite Links.
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
        participants: new Map(), // userId -> { user, card, isSelf, canvas, ctx }
        isJoined: false,
        isMuted: false,

        // Роли и статус комнаты
        hostId: null,
        isHost: false,
        isLocked: false,

        // Настройки
        echoCancellationEnabled: true,
        masterVolume: 1.0,
        micSensitivity: 100,

        // Комнаты и навигация
        selectedRoomId: 'main',
        selectedRoomName: 'main',
        currentRoomPassword: null,
        pendingRoomId: null,
        pendingRoomName: null,

        // Телеметрия и пинг
        pingInterval: null,
        visualizerAnimId: null,

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
        micSensitivity: document.getElementById('micSensitivity'),
        micSensitivityValue: document.getElementById('micSensitivityValue'),
        masterVolume: document.getElementById('masterVolume'),
        masterVolumeValue: document.getElementById('masterVolumeValue'),
        echoCancellation: document.getElementById('echoCancellation'),
        roomNameInput: document.getElementById('roomNameInput'),
        roomPasswordInput: document.getElementById('roomPasswordInput'),
        roomMaxUsersInput: document.getElementById('roomMaxUsersInput'),
        roomPasswordCheckInput: document.getElementById('roomPasswordCheckInput'),

        // Элементы хост-панели и инвайтов (создаются динамически или из HTML)
        hostControlsBar: null,
        lockRoomBtn: null,
        muteAllBtn: null,
        shareInviteBtn: null
    };

    // =========================================================================
    // Инициализация
    // =========================================================================
    document.addEventListener('DOMContentLoaded', () => {
        initUserProfile();
        setupDynamicHostBar();
        bindUIEvents();
        setupAudioCallbacks();
        checkInviteUrl();
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

    function setupDynamicHostBar() {
        // Создаем плавающую панель для хост-контроля и шеринга инвайт-ссылок
        let bar = document.getElementById('hostControlsBar');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'hostControlsBar';
            bar.className = 'host-controls-bar glass';
            bar.style.display = 'none';

            bar.innerHTML = `
                <button id="shareInviteBtn" class="action-chip" title="Скопировать ссылку для приглашения">🔗 Пригласить</button>
                <button id="lockRoomBtn" class="action-chip" title="Закрыть вход в комнату" style="display: none;">🔓 Открыта</button>
                <button id="muteAllBtn" class="action-chip danger" title="Заглушить всех собеседников" style="display: none;">🔇 Заглушить всех</button>
            `;

            const mainContent = document.querySelector('.main-content');
            if (mainContent) {
                mainContent.insertBefore(bar, dom.participantsGrid);
            }
        }

        dom.hostControlsBar = bar;
        dom.shareInviteBtn = document.getElementById('shareInviteBtn');
        dom.lockRoomBtn = document.getElementById('lockRoomBtn');
        dom.muteAllBtn = document.getElementById('muteAllBtn');
    }

    function checkInviteUrl() {
        // Парсинг параметров инвайта: voice.repozis.ru/#join=roomId&pwd=pass
        const hash = window.location.hash.substring(1);
        if (!hash) {
            showRoomSelectionView();
            return;
        }

        const params = new URLSearchParams(hash);
        const joinRoomId = params.get('join');
        const pwd = params.get('pwd');

        if (joinRoomId) {
            state.selectedRoomId = joinRoomId;
            state.selectedRoomName = joinRoomId;
            if (pwd) state.currentRoomPassword = pwd;

            selectRoom(joinRoomId, joinRoomId);
        } else {
            showRoomSelectionView();
        }
    }

    function setupAudioCallbacks() {
        window.audioManager.onAudioFrame = (pcmBuffer) => {
            if (state.isJoined && !state.isMuted && state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(pcmBuffer);
            }
        };

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

        // Хост-действия и инвайты
        if (dom.shareInviteBtn) dom.shareInviteBtn.addEventListener('click', () => copyInviteLink());
        if (dom.lockRoomBtn) dom.lockRoomBtn.addEventListener('click', () => toggleLockRoom());
        if (dom.muteAllBtn) dom.muteAllBtn.addEventListener('click', () => triggerMuteAll());

        if (dom.micSensitivity) {
            dom.micSensitivity.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10) || 0;
                state.micSensitivity = val;
                if (dom.micSensitivityValue) dom.micSensitivityValue.textContent = `${val}%`;
            });
        }

        if (dom.masterVolume) {
            dom.masterVolume.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10) || 0;
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
                        window.audioManager.playAudioPacket(event.data);
                    }
                };

                state.ws.onerror = (err) => {
                    console.error('[VoiceChat] WebSocket error:', err);
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

                // --- Телеметрия и Хост-контроль ---
                case 'pong':
                    onPong(msg.payload);
                    break;
                case 'user_ping_updated':
                    onUserPingUpdated(msg.payload);
                    break;
                case 'host_changed':
                    onHostChanged(msg.payload);
                    break;
                case 'room_locked_updated':
                    onRoomLockedUpdated(msg.payload);
                    break;
                case 'kicked':
                    onKicked(msg.payload);
                    break;
                case 'force_mute':
                    onForceMute();
                    break;
            }
        } catch (err) {
            console.error('[VoiceChat] Parse error:', err);
        }
    }

    function onRoomState(payload) {
        clearParticipantsUI();

        state.hostId = payload.hostId || null;
        state.isHost = Boolean(state.user && state.hostId === state.user.id);
        state.isLocked = Boolean(payload.isLocked);

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

        if (dom.hostControlsBar) {
            dom.hostControlsBar.style.display = 'flex';
        }

        updateHostControlsUI();
        updateRoomLabel();

        // Запуск фоновых процессов звонка
        startPingLoop();
        startVisualizerLoop();

        if (window.pwaManager) {
            window.pwaManager.acquireWakeLock();
            window.pwaManager.setupMediaSession(state.selectedRoomName);
        }
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
    // Пинг и Хост-контроль хендлеры
    // =========================================================================
    function onPong(payload) {
        if (!payload.clientTimestamp) return;
        const pingMs = Math.max(1, Date.now() - payload.clientTimestamp);
        if (state.user) {
            updateUserPingUI(state.user.id, pingMs);
            sendSignaling('ping_report', { pingMs });
        }
    }

    function onUserPingUpdated(payload) {
        if (payload.userId && typeof payload.pingMs === 'number') {
            updateUserPingUI(payload.userId, payload.pingMs);
        }
    }

    function onHostChanged(payload) {
        state.hostId = payload.hostId;
        state.isHost = Boolean(state.user && state.hostId === state.user.id);
        updateHostControlsUI();

        // Обновляем бейджи Хоста на карточках участников
        state.participants.forEach((p, uid) => {
            const isHost = (uid === state.hostId);
            const hostBadge = p.card.querySelector('.host-badge');
            if (hostBadge) hostBadge.style.display = isHost ? 'inline-block' : 'none';
        });
    }

    function onRoomLockedUpdated(payload) {
        state.isLocked = Boolean(payload.isLocked);
        if (dom.lockRoomBtn) {
            dom.lockRoomBtn.textContent = state.isLocked ? '🔒 Закрыта' : '🔓 Открыта';
            dom.lockRoomBtn.classList.toggle('danger', state.isLocked);
        }
    }

    function onKicked(payload) {
        alert(payload.message || 'Вы были исключены создателем комнаты');
        leaveRoom();
    }

    function onForceMute() {
        if (!state.isMuted) {
            toggleMute();
        }
    }

    function startPingLoop() {
        stopPingLoop();
        state.pingInterval = setInterval(() => {
            if (state.isJoined && state.ws && state.ws.readyState === WebSocket.OPEN) {
                sendSignaling('ping', { clientTimestamp: Date.now() });
            }
        }, 3000);
    }

    function stopPingLoop() {
        if (state.pingInterval) {
            clearInterval(state.pingInterval);
            state.pingInterval = null;
        }
    }

    // =========================================================================
    // Хост-действия и Инвайты
    // =========================================================================
    function copyInviteLink() {
        const url = new URL(window.location.origin + window.location.pathname);
        url.hash = `join=${encodeURIComponent(state.selectedRoomId)}`;
        if (state.currentRoomPassword) {
            url.hash += `&pwd=${encodeURIComponent(state.currentRoomPassword)}`;
        }

        navigator.clipboard.writeText(url.toString()).then(() => {
            if (dom.shareInviteBtn) {
                const originalText = dom.shareInviteBtn.textContent;
                dom.shareInviteBtn.textContent = '✓ Ссылка скопирована!';
                setTimeout(() => {
                    dom.shareInviteBtn.textContent = originalText;
                }, 2000);
            }
        }).catch(() => {
            prompt('Скопируйте ссылку для приглашения:', url.toString());
        });
    }

    function toggleLockRoom() {
        if (!state.isHost) return;
        const newLockState = !state.isLocked;
        sendSignaling('lock_room', { isLocked: newLockState });
    }

    function triggerMuteAll() {
        if (!state.isHost) return;
        if (confirm('Заглушить микрофоны всех участников?')) {
            sendSignaling('mute_all', { isMuted: true });
        }
    }

    function triggerKickUser(targetUserId, targetUserName) {
        if (!state.isHost) return;
        if (confirm(`Исключить ${targetUserName} из комнаты?`)) {
            sendSignaling('kick_user', { targetUserId });
        }
    }

    function updateHostControlsUI() {
        const display = state.isHost ? 'inline-flex' : 'none';
        if (dom.lockRoomBtn) {
            dom.lockRoomBtn.style.display = display;
            dom.lockRoomBtn.textContent = state.isLocked ? '🔒 Закрыта' : '🔓 Открыта';
            dom.lockRoomBtn.classList.toggle('danger', state.isLocked);
        }
        if (dom.muteAllBtn) {
            dom.muteAllBtn.style.display = display;
        }

        // Обновляем видимость кнопок Kick на карточках
        state.participants.forEach((p, uid) => {
            const kickBtn = p.card.querySelector('.kick-btn');
            if (kickBtn) {
                kickBtn.style.display = (state.isHost && !p.isSelf) ? 'flex' : 'none';
            }
        });
    }

    // =========================================================================
    // UI & Управление вызовами
    // =========================================================================
    async function joinRoom() {
        if (!state.user) initUserProfile();

        try {
            await window.audioManager.init();
            await window.audioManager.startMicrophone(state.echoCancellationEnabled);
        } catch (err) {
            console.error('[VoiceChat] Microphone access failed:', err);
            alert('Не удалось получить доступ к микрофону. Проверьте разрешения в браузере.');
            return;
        }

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

        stopPingLoop();
        stopVisualizerLoop();

        if (window.pwaManager) {
            window.pwaManager.releaseWakeLock();
        }

        window.audioManager.stopMicrophone();
        state.isJoined = false;
        clearParticipantsUI();

        if (dom.hostControlsBar) dom.hostControlsBar.style.display = 'none';
        dom.participantsGrid.style.display = 'none';
        dom.footerControls.style.display = 'none';

        window.location.hash = '';
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
        stopPingLoop();
        stopVisualizerLoop();
        window.audioManager.stopMicrophone();

        state.isJoined = false;
        clearParticipantsUI();

        if (dom.hostControlsBar) dom.hostControlsBar.style.display = 'none';
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
        if (dom.micSensitivity) {
            dom.micSensitivity.value = state.micSensitivity;
            if (dom.micSensitivityValue) dom.micSensitivityValue.textContent = `${state.micSensitivity}%`;
        }
        if (dom.masterVolume) {
            const volPercent = Math.round(state.masterVolume * 100);
            dom.masterVolume.value = volPercent;
            if (dom.masterVolumeValue) dom.masterVolumeValue.textContent = `${volPercent}%`;
        }
        if (dom.settingsModal) dom.settingsModal.style.display = 'flex';
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

        if (dom.settingsModal) dom.settingsModal.style.display = 'none';
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
    // Карточки участников, Телеметрия и Визуализатор волн (60 FPS)
    // =========================================================================
    function addParticipantToUI(user, isSelf = false) {
        if (!user || !user.id || state.participants.has(user.id)) return;

        const card = document.createElement('div');
        card.className = 'participant-card glass';
        card.id = `participant-${user.id}`;

        // Кнопка Kick (для Хоста)
        const kickBtn = document.createElement('button');
        kickBtn.className = 'kick-btn';
        kickBtn.title = 'Исключить участника';
        kickBtn.textContent = '✕';
        kickBtn.style.display = (state.isHost && !isSelf) ? 'flex' : 'none';
        kickBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            triggerKickUser(user.id, user.name);
        });
        card.appendChild(kickBtn);

        // Индикатор пинга (Badge)
        const pingBadge = document.createElement('div');
        pingBadge.className = 'ping-badge ping-good';
        pingBadge.id = `ping-${user.id}`;
        pingBadge.textContent = '0ms';
        card.appendChild(pingBadge);

        // Обертка аватара с холстом визуализатора волн
        const avatarWrapper = document.createElement('div');
        avatarWrapper.className = 'avatar-wrapper';

        const canvas = document.createElement('canvas');
        canvas.className = 'avatar-visualizer-canvas';
        canvas.width = 120;
        canvas.height = 120;
        const ctx = canvas.getContext('2d');

        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.background = user.avatarColor || getRandomAvatarColor();
        avatar.textContent = (user.name || 'U').charAt(0).toUpperCase();

        avatarWrapper.appendChild(canvas);
        avatarWrapper.appendChild(avatar);
        card.appendChild(avatarWrapper);

        // Имя и бейдж Хоста
        const nameContainer = document.createElement('div');
        nameContainer.className = 'name-container';

        const name = document.createElement('div');
        name.className = 'participant-name';
        name.textContent = isSelf ? `${user.name} (Вы)` : user.name;
        nameContainer.appendChild(name);

        const isUserHost = (user.id === state.hostId);
        const hostBadge = document.createElement('span');
        hostBadge.className = 'host-badge';
        hostBadge.textContent = '👑 Хост';
        hostBadge.style.display = isUserHost ? 'inline-block' : 'none';
        nameContainer.appendChild(hostBadge);

        card.appendChild(nameContainer);

        // Ползунок громкости собеседника
        if (!isSelf) {
            const volContainer = document.createElement('div');
            volContainer.className = 'range-wrapper';
            volContainer.style.marginTop = '0.75rem';

            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.min = '0';
            volSlider.max = '200';
            volSlider.value = '100';
            volSlider.className = 'volume-control';
            volSlider.title = 'Громкость собеседника';

            const volValue = document.createElement('span');
            volValue.textContent = '100%';
            volValue.style.fontSize = '0.8rem';
            volValue.style.minWidth = '38px';

            volSlider.addEventListener('input', (e) => {
                const percent = parseInt(e.target.value, 10) || 0;
                volValue.textContent = `${percent}%`;
                window.audioManager.setParticipantVolume(user.id, percent / 100);
            });

            volContainer.appendChild(volSlider);
            volContainer.appendChild(volValue);
            card.appendChild(volContainer);
        }

        if (dom.participantsGrid) {
            dom.participantsGrid.appendChild(card);
        }

        state.participants.set(user.id, { user, card, isSelf, canvas, ctx });
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

    function updateUserPingUI(userId, pingMs) {
        const pingEl = document.getElementById(`ping-${userId}`);
        if (!pingEl) return;

        pingEl.textContent = `${pingMs}ms`;
        pingEl.className = 'ping-badge';

        if (pingMs < 80) {
            pingEl.classList.add('ping-good');
        } else if (pingMs < 180) {
            pingEl.classList.add('ping-medium');
        } else {
            pingEl.classList.add('ping-bad');
        }
    }

    // =========================================================================
    // Отрисовка живой волны / спектра (Canvas Voice Visualizer)
    // =========================================================================
    function startVisualizerLoop() {
        stopVisualizerLoop();

        const render = () => {
            state.participants.forEach((p, userId) => {
                if (!p.ctx || !p.canvas) return;

                const freqData = window.audioManager.getFrequencyData(p.isSelf ? 'self' : userId);
                drawWaveVisualizer(p.ctx, p.canvas, freqData);
            });

            state.visualizerAnimId = requestAnimationFrame(render);
        };

        state.visualizerAnimId = requestAnimationFrame(render);
    }

    function stopVisualizerLoop() {
        if (state.visualizerAnimId) {
            cancelAnimationFrame(state.visualizerAnimId);
            state.visualizerAnimId = null;
        }
    }

    function drawWaveVisualizer(ctx, canvas, freqData) {
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        if (!freqData || freqData.length === 0) return;

        // Расчет средней энергии низких и средних частот
        let sum = 0;
        const count = Math.min(freqData.length, 16);
        for (let i = 0; i < count; i++) {
            sum += freqData[i];
        }
        const avg = sum / count;

        if (avg < 5) return; // Порог тишины

        const centerX = canvas.width / 2;
        const centerY = canvas.height / 2;
        const baseRadius = 36;
        const maxWaveHeight = 16;
        const waveScale = (avg / 255) * maxWaveHeight;

        ctx.save();
        ctx.beginPath();
        ctx.arc(centerX, centerY, baseRadius + waveScale, 0, 2 * Math.PI);
        ctx.strokeStyle = `rgba(124, 108, 255, ${Math.min(0.8, avg / 180)})`;
        ctx.lineWidth = 2.5;
        ctx.shadowBlur = 10;
        ctx.shadowColor = '#7c6cff';
        ctx.stroke();

        // Дополнительное внешнее пульсирующее кольцо при громкой речи
        if (avg > 80) {
            ctx.beginPath();
            ctx.arc(centerX, centerY, baseRadius + waveScale * 1.5, 0, 2 * Math.PI);
            ctx.strokeStyle = `rgba(167, 139, 250, ${Math.min(0.4, avg / 255)})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();
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