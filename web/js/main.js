/**
 * VoiceChat Client Engine - web/js/main.js
 * 
 * Features:
 * - WebSocket Signaling & Real-Time Audio Transport
 * - Minecraft GTNH Telemetry Integration & 3D Spatial Audio (HRTF + Reverb)
 * - Text Micro-Chat with Drag-and-Drop & Clipboard File Sharing
 * - Host Controls (Room Lock, Kick, Mute All) & Server-Side DSP Filter Selection
 * - Dynamic QR Code Generator on Canvas & Room Invite Deep Links
 * - 60 FPS Frequency Wave Visualizer & VAD Speaking Animation
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
        minecraftMode: false,
        spatialEngine: null,

        // Настройки аудио и DSP
        voiceFilter: 'none',
        echoCancellationEnabled: false,
        masterVolume: 1.0,
        micSensitivity: 100,

        // Комнаты и навигация
        selectedRoomId: 'main',
        selectedRoomName: 'main',
        currentRoomPassword: null,
        pendingRoomId: null,
        pendingRoomName: null,

        // Чат и уведомления
        isChatOpen: false,
        unreadCount: 0,

        // Фоновые процессы
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
        header: document.querySelector('.header'),
        mainContent: document.querySelector('.main-content'),
        currentRoomLabel: document.getElementById('currentRoomLabel'),
        roomSelectionPanel: document.getElementById('roomSelectionPanel'),
        roomsList: document.getElementById('roomsList'),
        createRoomBtn: document.getElementById('createRoomBtn'),
        refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
        connectionPanel: document.getElementById('connectionPanel'),
        selectedRoomInfo: document.getElementById('selectedRoomInfo'),
        joinBtn: document.getElementById('joinBtn'),
        backToRoomsBtn: document.getElementById('backToRoomsBtn'),
        callWorkspace: document.getElementById('callWorkspace'),
        participantsGrid: document.getElementById('participantsGrid'),
        footerControls: document.getElementById('footerControls'),
        micBtn: document.getElementById('micBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        settingsBtn: document.getElementById('settingsBtn'),

        // Хост-панель
        hostControlsBar: document.getElementById('hostControlsBar'),
        shareInviteBtn: document.getElementById('shareInviteBtn'),
        lockRoomBtn: document.getElementById('lockRoomBtn'),
        muteAllBtn: document.getElementById('muteAllBtn'),

        // Текстовый микро-чат
        chatToggleBtn: document.getElementById('chatToggleBtn'),
        chatUnreadBadge: document.getElementById('chatUnreadBadge'),
        chatPanel: document.getElementById('chatPanel'),
        closeChatBtn: document.getElementById('closeChatBtn'),
        chatMessages: document.getElementById('chatMessages'),
        chatForm: document.getElementById('chatForm'),
        chatInput: document.getElementById('chatInput'),
        chatFileInput: document.getElementById('chatFileInput'),
        chatAttachBtn: document.getElementById('chatAttachBtn'),
        chatSendBtn: document.getElementById('chatSendBtn'),

        // Модалка настроек
        settingsModal: document.getElementById('settingsModal'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn'),
        settingsUserName: document.getElementById('settingsUserName'),
        voiceFilterSelect: document.getElementById('voiceFilterSelect'),
        micSensitivity: document.getElementById('micSensitivity'),
        micSensitivityValue: document.getElementById('micSensitivityValue'),
        masterVolume: document.getElementById('masterVolume'),
        masterVolumeValue: document.getElementById('masterVolumeValue'),
        echoCancellation: document.getElementById('echoCancellation'),

        // Модалка создания комнаты
        createRoomModal: document.getElementById('createRoomModal'),
        roomNameInput: document.getElementById('roomNameInput'),
        roomPasswordInput: document.getElementById('roomPasswordInput'),
        roomMaxUsersInput: document.getElementById('roomMaxUsersInput'),
        roomMinecraftModeInput: document.getElementById('roomMinecraftModeInput'),
        confirmCreateRoomBtn: document.getElementById('confirmCreateRoomBtn'),
        cancelCreateRoomBtn: document.getElementById('cancelCreateRoomBtn'),

        // Модалка ввода пароля
        passwordModal: document.getElementById('passwordModal'),
        roomPasswordCheckInput: document.getElementById('roomPasswordCheckInput'),
        confirmPasswordBtn: document.getElementById('confirmPasswordBtn'),
        cancelPasswordBtn: document.getElementById('cancelPasswordBtn'),

        // Модалка QR-кода и инвайта
        inviteModal: document.getElementById('inviteModal'),
        inviteQrCanvas: document.getElementById('inviteQrCanvas'),
        inviteUrlInput: document.getElementById('inviteUrlInput'),
        copyInviteUrlBtn: document.getElementById('copyInviteUrlBtn'),
        closeInviteModalBtn: document.getElementById('closeInviteModalBtn')
    };

    // =========================================================================
    // Инициализация приложения
    // =========================================================================
    document.addEventListener('DOMContentLoaded', () => {
        window.appState = state; // Экспорт для audio.js и spatial.js
        initUserProfile();
        bindUIEvents();
        setupAudioCallbacks();
        setupChatDragAndDrop();
        setupClipboardPaste();
        checkInviteUrl();
    });

    function initUserProfile() {
        let name = localStorage.getItem('voicechat_username');
        if (!name || !name.trim()) {
            name = 'Player_' + Math.floor(100 + Math.random() * 900);
            localStorage.setItem('voicechat_username', name);
        }

        const savedFilter = localStorage.getItem('voicechat_filter') || 'none';
        state.voiceFilter = savedFilter;

        state.user = {
            id: 'u_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36).slice(-4),
            name: name.trim(),
            avatarColor: getRandomAvatarColor(),
            voiceFilter: state.voiceFilter
        };

        if (dom.settingsUserName) dom.settingsUserName.value = state.user.name;
        if (dom.voiceFilterSelect) dom.voiceFilterSelect.value = state.voiceFilter;
    }

    function checkInviteUrl() {
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
        if (dom.backToRoomsBtn) dom.backToRoomsBtn.addEventListener('click', () => showRoomSelectionView());
        if (dom.refreshRoomsBtn) dom.refreshRoomsBtn.addEventListener('click', () => requestRoomsList());
        if (dom.createRoomBtn) dom.createRoomBtn.addEventListener('click', () => openCreateRoomModal());
        if (dom.settingsBtn) dom.settingsBtn.addEventListener('click', () => openSettingsModal());
        if (dom.closeSettingsBtn) dom.closeSettingsBtn.addEventListener('click', () => saveSettings());

        if (dom.shareInviteBtn) dom.shareInviteBtn.addEventListener('click', () => openInviteModal());
        if (dom.lockRoomBtn) dom.lockRoomBtn.addEventListener('click', () => toggleLockRoom());
        if (dom.muteAllBtn) dom.muteAllBtn.addEventListener('click', () => triggerMuteAll());
        if (dom.closeInviteModalBtn) dom.closeInviteModalBtn.addEventListener('click', () => closeInviteModal());
        if (dom.copyInviteUrlBtn) dom.copyInviteUrlBtn.addEventListener('click', () => copyInviteLink());

        if (dom.chatToggleBtn) dom.chatToggleBtn.addEventListener('click', () => toggleChatPanel());
        if (dom.closeChatBtn) dom.closeChatBtn.addEventListener('click', () => toggleChatPanel(false));
        if (dom.chatForm) dom.chatForm.addEventListener('submit', (e) => { e.preventDefault(); handleSendTextMessage(); });
        if (dom.chatAttachBtn) dom.chatAttachBtn.addEventListener('click', () => dom.chatFileInput && dom.chatFileInput.click());
        if (dom.chatFileInput) dom.chatFileInput.addEventListener('change', handleFileSelect);

        if (dom.confirmCreateRoomBtn) dom.confirmCreateRoomBtn.addEventListener('click', () => handleCreateRoomSubmit());
        if (dom.cancelCreateRoomBtn) dom.cancelCreateRoomBtn.addEventListener('click', () => closeCreateRoomModal());
        if (dom.confirmPasswordBtn) dom.confirmPasswordBtn.addEventListener('click', () => handlePasswordSubmit());
        if (dom.cancelPasswordBtn) dom.cancelPasswordBtn.addEventListener('click', () => closePasswordModal());

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
                case 'user_filter_updated':
                    onUserFilterUpdated(msg.payload);
                    break;
                case 'chat_message':
                    onChatMessage(msg.payload);
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
                case 'minecraft_telemetry':
                    onMinecraftTelemetry(msg.payload);
                    break;
            }
        } catch (err) {
            console.error('[VoiceChat] Parse error:', err);
        }
    }

    function onRoomState(payload) {
        clearParticipantsUI();
        clearChatUI();

        state.hostId = payload.hostId || null;
        state.isHost = Boolean(state.user && state.hostId === state.user.id);
        state.isLocked = Boolean(payload.isLocked);
        state.minecraftMode = Boolean(payload.minecraftMode);

        if (state.minecraftMode && window.SpatialAudioEngine) {
            state.spatialEngine = new window.SpatialAudioEngine(window.audioManager);
            state.spatialEngine.init();
        } else {
            state.spatialEngine = null;
        }

        if (Array.isArray(payload.users)) {
            payload.users.forEach(u => {
                const isSelf = Boolean(state.user && u.id === state.user.id);
                addParticipantToUI(u, isSelf);
            });
        }

        if (Array.isArray(payload.messages)) {
            payload.messages.forEach(m => {
                const isSelf = Boolean(state.user && m.userId === state.user.id);
                addChatMessageToUI(m, isSelf);
            });
        }

        state.isJoined = true;
        dom.connectionPanel.style.display = 'none';
        dom.callWorkspace.style.display = 'flex';
        dom.footerControls.style.display = 'flex';

        if (dom.chatToggleBtn) dom.chatToggleBtn.style.display = 'flex';
        if (dom.hostControlsBar) dom.hostControlsBar.style.display = 'flex';

        if (state.voiceFilter !== 'none') {
            sendSignaling('set_voice_filter', { filter: state.voiceFilter });
        }

        updateHostControlsUI();
        updateRoomLabel();

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
            if (state.spatialEngine) {
                state.spatialEngine.removeChain(payload.userId);
            }
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

    function onUserFilterUpdated(payload) {
        const card = document.getElementById(`participant-${payload.userId}`);
        if (card) {
            const filterBadge = card.querySelector('.filter-badge');
            if (filterBadge) {
                if (payload.voiceFilter && payload.voiceFilter !== 'none') {
                    filterBadge.textContent = getFilterLabel(payload.voiceFilter);
                    filterBadge.style.display = 'inline-block';
                } else {
                    filterBadge.style.display = 'none';
                }
            }
        }
    }

    function onChatMessage(payload) {
        if (!payload) return;
        const isSelf = Boolean(state.user && payload.userId === state.user.id);
        addChatMessageToUI(payload, isSelf);

        if (!state.isChatOpen && !isSelf) {
            state.unreadCount++;
            if (dom.chatUnreadBadge) {
                dom.chatUnreadBadge.textContent = state.unreadCount;
                dom.chatUnreadBadge.style.display = 'flex';
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

            if (room.minecraftMode) {
                name.innerHTML = `<span title="Режим Minecraft GTNH">⛏️</span> ${escapeHTML(room.name)}`;
            } else {
                name.textContent = room.name;
            }

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

    function onMinecraftTelemetry(payload) {
        if (!payload || !Array.isArray(payload.players)) return;

        const myName = (state.user?.name || '').trim().toLowerCase();
        let myTelemetry = null;

        // 1. Поиск локального игрока
        for (const p of payload.players) {
            if (p.username && p.username.trim().toLowerCase() === myName) {
                myTelemetry = p;
                break;
            }
        }

        if (myTelemetry && state.spatialEngine) {
            state.spatialEngine.updateListener(
                myTelemetry.x,
                myTelemetry.y,
                myTelemetry.z,
                myTelemetry.yaw,
                myTelemetry.pitch,
                myTelemetry.inCave
            );
        }

        // 2. Обновление координат остальных участников
        let matchedCount = 0;
        let lastDistStr = '';

        for (const p of payload.players) {
            const pName = (p.username || '').trim().toLowerCase();
            if (pName === myName) continue;

            for (const [userId, participant] of state.participants.entries()) {
                const uName = (participant.user?.name || '').trim().toLowerCase();
                if (uName === pName) {
                    if (state.spatialEngine) {
                        state.spatialEngine.updateRemotePlayer(
                            userId,
                            p.x,
                            p.y,
                            p.z,
                            p.dimension,
                            p.inCave
                        );
                    }

                    if (myTelemetry) {
                        const dx = p.x - myTelemetry.x;
                        const dy = p.y - myTelemetry.y;
                        const dz = p.z - myTelemetry.z;
                        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz).toFixed(1);
                        lastDistStr = `[${p.username}: ${dist}м]`;
                    }
                    matchedCount++;
                    break;
                }
            }
        }

        // 3. Вывод статуса на плашку в шапке
        if (dom.mcStatusBadge) {
            if (!myTelemetry) {
                dom.mcStatusBadge.innerText = `⚠️ MC: Ник "${state.user?.name}" не найден на сервере!`;
                dom.mcStatusBadge.style.color = '#ef4444';
            } else {
                dom.mcStatusBadge.innerText = `⛏️ 3D активен: Вы (${myTelemetry.x.toFixed(0)}, ${myTelemetry.z.toFixed(0)}) | ${matchedCount} рядом ${lastDistStr}`;
                dom.mcStatusBadge.style.color = '#10b981';
            }
        }
    }

    // =========================================================================
    // Текстовый микро-чат и загрузка файлов
    // =========================================================================
    function toggleChatPanel(forceState) {
        state.isChatOpen = (typeof forceState === 'boolean') ? forceState : !state.isChatOpen;
        if (dom.chatPanel) {
            dom.chatPanel.style.display = state.isChatOpen ? 'flex' : 'none';
        }

        if (state.isChatOpen) {
            state.unreadCount = 0;
            if (dom.chatUnreadBadge) dom.chatUnreadBadge.style.display = 'none';
            if (dom.chatInput) dom.chatInput.focus();
            scrollChatToBottom();
        }
    }

    function handleSendTextMessage() {
        if (!dom.chatInput) return;
        const text = dom.chatInput.value.trim();
        if (!text) return;

        sendSignaling('send_message', { content: text });
        dom.chatInput.value = '';
    }

    async function uploadAndSendFile(file) {
        if (!file) return;

        if (file.size > 50 * 1024 * 1024) {
            alert('Файл слишком большой. Максимальный размер: 50 МБ');
            return;
        }

        const formData = new FormData();
        formData.append('file', file);

        try {
            const resp = await fetch('/api/upload', {
                method: 'POST',
                body: formData
            });

            if (!resp.ok) throw new Error('Ошибка при загрузке');

            const data = await resp.json();
            sendSignaling('send_file', {
                fileUrl: data.url,
                fileName: data.fileName,
                fileType: data.fileType,
                fileSize: data.fileSize
            });
        } catch (err) {
            console.error('[VoiceChat] Upload failed:', err);
            alert('Не удалось загрузить файл.');
        }
    }

    function handleFileSelect(e) {
        const file = e.target.files && e.target.files[0];
        if (file) {
            uploadAndSendFile(file);
            e.target.value = '';
        }
    }

    function setupClipboardPaste() {
        document.addEventListener('paste', (e) => {
            if (!state.isJoined) return;
            const items = e.clipboardData && e.clipboardData.items;
            if (!items) return;

            for (let i = 0; i < items.length; i++) {
                if (items[i].kind === 'file') {
                    const file = items[i].getAsFile();
                    if (file) {
                        toggleChatPanel(true);
                        uploadAndSendFile(file);
                        e.preventDefault();
                        break;
                    }
                }
            }
        });
    }

    function setupChatDragAndDrop() {
        const dropZone = document.body;

        ['dragenter', 'dragover'].forEach(eventName => {
            dropZone.addEventListener(eventName, (e) => {
                if (!state.isJoined) return;
                e.preventDefault();
                e.stopPropagation();
            });
        });

        dropZone.addEventListener('drop', (e) => {
            if (!state.isJoined) return;
            e.preventDefault();
            e.stopPropagation();

            const dt = e.dataTransfer;
            const files = dt && dt.files;
            if (files && files.length > 0) {
                toggleChatPanel(true);
                uploadAndSendFile(files[0]);
            }
        });
    }

    function addChatMessageToUI(msg, isSelf = false) {
        if (!dom.chatMessages || !msg) return;

        const row = document.createElement('div');
        row.className = `chat-msg-row ${isSelf ? 'self' : 'other'}`;

        if (!isSelf) {
            const author = document.createElement('div');
            author.className = 'chat-msg-author';
            author.textContent = msg.userName || 'Аноним';
            row.appendChild(author);
        }

        const bubble = document.createElement('div');
        bubble.className = 'chat-bubble';

        if (msg.content) {
            const textSpan = document.createElement('span');
            textSpan.textContent = msg.content;
            bubble.appendChild(textSpan);
        }

        if (msg.fileType === 'image' && msg.fileURL) {
            const img = document.createElement('img');
            img.src = msg.fileURL;
            img.alt = msg.fileName || 'Вложение';
            img.className = 'chat-img-preview';
            img.addEventListener('click', () => window.open(msg.fileURL, '_blank'));
            bubble.appendChild(img);
        } else if (msg.fileURL) {
            const fileLink = document.createElement('a');
            fileLink.href = msg.fileURL;
            fileLink.download = msg.fileName || 'file';
            fileLink.target = '_blank';
            fileLink.className = 'chat-file-attachment';
            fileLink.innerHTML = `📄 ${escapeHTML(msg.fileName || 'Файл')} <small>(${formatBytes(msg.fileSize || 0)})</small>`;
            bubble.appendChild(fileLink);
        }

        const timeEl = document.createElement('div');
        timeEl.className = 'chat-msg-time';
        const d = msg.timestamp ? new Date(msg.timestamp) : new Date();
        timeEl.textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        bubble.appendChild(timeEl);

        row.appendChild(bubble);
        dom.chatMessages.appendChild(row);
        scrollChatToBottom();
    }

    function clearChatUI() {
        if (dom.chatMessages) dom.chatMessages.innerHTML = '';
        state.unreadCount = 0;
        if (dom.chatUnreadBadge) dom.chatUnreadBadge.style.display = 'none';
    }

    function scrollChatToBottom() {
        if (dom.chatMessages) {
            dom.chatMessages.scrollTop = dom.chatMessages.scrollHeight;
        }
    }

    // =========================================================================
    // QR-код генератор и Модалка приглашения
    // =========================================================================
    function openInviteModal() {
        const url = new URL(window.location.origin + window.location.pathname);
        url.hash = `join=${encodeURIComponent(state.selectedRoomId)}`;
        if (state.currentRoomPassword) {
            url.hash += `&pwd=${encodeURIComponent(state.currentRoomPassword)}`;
        }

        const inviteLink = url.toString();
        if (dom.inviteUrlInput) dom.inviteUrlInput.value = inviteLink;

        if (dom.inviteQrCanvas) {
            renderQRCodeToCanvas(dom.inviteQrCanvas, inviteLink);
        }

        if (dom.inviteModal) dom.inviteModal.style.display = 'flex';
    }

    function closeInviteModal() {
        if (dom.inviteModal) dom.inviteModal.style.display = 'none';
    }

    function copyInviteLink() {
        const text = dom.inviteUrlInput ? dom.inviteUrlInput.value : '';
        if (!text) return;

        navigator.clipboard.writeText(text).then(() => {
            if (dom.copyInviteUrlBtn) {
                const orig = dom.copyInviteUrlBtn.textContent;
                dom.copyInviteUrlBtn.textContent = '✓ Скопировано!';
                setTimeout(() => { dom.copyInviteUrlBtn.textContent = orig; }, 2000);
            }
        }).catch(() => {
            prompt('Ссылка для приглашения:', text);
        });
    }

    function renderQRCodeToCanvas(canvas, text) {
        const ctx = canvas.getContext('2d');
        const size = canvas.width;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, size, size);

        const qrMatrix = generateQRMatrix(text);
        const moduleCount = qrMatrix.length;
        const cellSize = (size - 24) / moduleCount;
        const offset = 12;

        ctx.fillStyle = '#0a0a0f';
        for (let r = 0; r < moduleCount; r++) {
            for (let c = 0; c < moduleCount; c++) {
                if (qrMatrix[r][c]) {
                    ctx.fillRect(offset + c * cellSize, offset + r * cellSize, cellSize + 0.3, cellSize + 0.3);
                }
            }
        }
    }

    function generateQRMatrix(data) {
        const bytes = new TextEncoder().encode(data);
        const version = bytes.length > 50 ? 5 : (bytes.length > 25 ? 3 : 2);
        const size = version * 4 + 17;
        const matrix = Array.from({ length: size }, () => Array(size).fill(false));
        const isReserved = Array.from({ length: size }, () => Array(size).fill(false));

        const setFinder = (r, c) => {
            for (let i = -1; i <= 7; i++) {
                for (let j = -1; j <= 7; j++) {
                    const row = r + i, col = c + j;
                    if (row >= 0 && row < size && col >= 0 && col < size) {
                        isReserved[row][col] = true;
                        const isBorder = i === -1 || i === 7 || j === -1 || j === 7;
                        const isOuter = i === 0 || i === 6 || j === 0 || j === 6;
                        const isCenter = i >= 2 && i <= 4 && j >= 2 && j <= 4;
                        matrix[row][col] = !isBorder && (isOuter || isCenter);
                    }
                }
            }
        };

        setFinder(0, 0);
        setFinder(0, size - 7);
        setFinder(size - 7, 0);

        for (let i = 8; i < size - 8; i++) {
            isReserved[6][i] = true;
            matrix[6][i] = (i % 2 === 0);
            isReserved[i][6] = true;
            matrix[i][6] = (i % 2 === 0);
        }

        let bitIndex = 0;
        const bits = [];
        for (let i = 0; i < bytes.length; i++) {
            for (let b = 7; b >= 0; b--) {
                bits.push((bytes[i] >> b) & 1);
            }
        }

        let right = size - 1;
        while (right > 0) {
            if (right === 6) right--;
            for (let vert = 0; vert < size; vert++) {
                for (let colOffset = 0; colOffset < 2; colOffset++) {
                    const c = right - colOffset;
                    const r = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
                    if (!isReserved[r][c]) {
                        const bit = bitIndex < bits.length ? bits[bitIndex++] : 0;
                        const mask = (r + c) % 2 === 0;
                        matrix[r][c] = Boolean(bit ^ (mask ? 1 : 0));
                    }
                }
            }
            right -= 2;
        }

        return matrix;
    }

    // =========================================================================
    // Хост-действия
    // =========================================================================
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
        if (dom.muteAllBtn) dom.muteAllBtn.style.display = display;

        state.participants.forEach((p, uid) => {
            const kickBtn = p.card.querySelector('.kick-btn');
            if (kickBtn) {
                kickBtn.style.display = (state.isHost && !p.isSelf) ? 'flex' : 'none';
            }
        });
    }

    // =========================================================================
    // Управление вызовами и UI
    // =========================================================================
    async function joinRoom() {
        if (!state.user) initUserProfile();

        try {
            await window.audioManager.init();
            await window.audioManager.startMicrophone(state.echoCancellationEnabled);
        } catch (err) {
            console.error('[VoiceChat] Microphone access failed:', err);
            alert('Не удалось получить доступ к микрофону. Проверьте разрешения.');
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
        state.spatialEngine = null;
        clearParticipantsUI();
        clearChatUI();

        if (dom.chatToggleBtn) dom.chatToggleBtn.style.display = 'none';
        if (dom.chatPanel) dom.chatPanel.style.display = 'none';
        if (dom.hostControlsBar) dom.hostControlsBar.style.display = 'none';
        if (dom.callWorkspace) dom.callWorkspace.style.display = 'none';
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
        closeInviteModal();
        stopPingLoop();
        stopVisualizerLoop();
        window.audioManager.stopMicrophone();

        state.isJoined = false;
        state.spatialEngine = null;
        clearParticipantsUI();
        clearChatUI();

        if (dom.chatToggleBtn) dom.chatToggleBtn.style.display = 'none';
        if (dom.chatPanel) dom.chatPanel.style.display = 'none';
        if (dom.hostControlsBar) dom.hostControlsBar.style.display = 'none';
        if (dom.callWorkspace) dom.callWorkspace.style.display = 'none';
        dom.roomSelectionPanel.style.display = 'block';
        dom.connectionPanel.style.display = 'none';
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
        if (dom.voiceFilterSelect) {
            dom.voiceFilterSelect.value = state.voiceFilter;
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

        if (dom.voiceFilterSelect) {
            const newFilter = dom.voiceFilterSelect.value;
            if (newFilter !== state.voiceFilter) {
                state.voiceFilter = newFilter;
                localStorage.setItem('voicechat_filter', newFilter);
                if (state.isJoined) {
                    sendSignaling('set_voice_filter', { filter: newFilter });
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
        const minecraftMode = dom.roomMinecraftModeInput ? dom.roomMinecraftModeInput.checked : false;

        const payload = {
            roomName,
            maxUsers: Math.min(10, Math.max(2, maxUsers)),
            minecraftMode
        };
        if (password) payload.password = password;

        try {
            await connectWebSocket();
            sendSignaling('create_room', payload);
            closeCreateRoomModal();
            if (dom.roomNameInput) dom.roomNameInput.value = '';
            if (dom.roomPasswordInput) dom.roomPasswordInput.value = '';
            if (dom.roomMinecraftModeInput) dom.roomMinecraftModeInput.checked = false;
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
    // Карточки участников, Пинг и Визуализатор
    // =========================================================================
    function addParticipantToUI(user, isSelf = false) {
        if (!user || !user.id || state.participants.has(user.id)) return;

        const card = document.createElement('div');
        card.className = 'participant-card glass';
        card.id = `participant-${user.id}`;

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

        const pingBadge = document.createElement('div');
        pingBadge.className = 'ping-badge ping-good';
        pingBadge.id = `ping-${user.id}`;
        pingBadge.textContent = '0ms';
        card.appendChild(pingBadge);

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

        const filterBadge = document.createElement('span');
        filterBadge.className = 'host-badge filter-badge';
        filterBadge.style.background = 'rgba(124, 108, 255, 0.15)';
        filterBadge.style.borderColor = 'rgba(124, 108, 255, 0.3)';
        filterBadge.style.color = '#c4b5fd';
        if (user.voiceFilter && user.voiceFilter !== 'none') {
            filterBadge.textContent = getFilterLabel(user.voiceFilter);
            filterBadge.style.display = 'inline-block';
        } else {
            filterBadge.style.display = 'none';
        }
        nameContainer.appendChild(filterBadge);

        card.appendChild(nameContainer);

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

        let sum = 0;
        const count = Math.min(freqData.length, 16);
        for (let i = 0; i < count; i++) {
            sum += freqData[i];
        }
        const avg = sum / count;

        if (avg < 5) return;

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

        if (avg > 80) {
            ctx.beginPath();
            ctx.arc(centerX, centerY, baseRadius + waveScale * 1.5, 0, 2 * Math.PI);
            ctx.strokeStyle = `rgba(167, 139, 250, ${Math.min(0.4, avg / 255)})`;
            ctx.lineWidth = 1.5;
            ctx.stroke();
        }
        ctx.restore();
    }

    // =========================================================================
    // Вспомогательные утилиты
    // =========================================================================
    function getFilterLabel(filterKey) {
        const labels = {
            'radio': '📻 Рация',
            'robot': '🤖 Робот',
            'megaphone': '📢 Мегафон',
            'demon': '😈 Демон'
        };
        return labels[filterKey] || filterKey;
    }

    function getRandomAvatarColor() {
        const palette = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b', '#20c997', '#f06595'];
        return palette[Math.floor(Math.random() * palette.length)];
    }

    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    function escapeHTML(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }
})();