/**
 * VoiceChat Client Engine - web/js/main.js
 * High-performance WebSocket & Web Audio API integration.
 * Processing & DSP are delegated to the server to minimize client device load.
 */

(() => {
    'use strict';

    if (window.voiceChatAppInitialized) {
        console.warn('[VoiceChat] Application already initialized.');
        return;
    }
    window.voiceChatAppInitialized = true;

    // =========================================================================
    // Конфигурация и аудио-спецификация
    // =========================================================================
    const AUDIO_CONFIG = {
        sampleRate: 16000,          // 16 kHz: оптимум для передачи голоса и DSP
        frameDurationMs: 20,        // 20 мс квант аудио
        frameSamples: 320,          // 16000 * 0.02 = 320 сэмплов на фрейм
        channels: 1,                // Моно
        jitterBufferMs: 60,         // Целевой джиттер-буфер для сглаживания сетевых задержек
        minVADThreshold: 0.01       // Порог активации голоса для UI-индикации
    };

    // =========================================================================
    // Состояние приложения
    // =========================================================================
    const state = {
        ws: null,
        user: null,
        participants: new Map(), // userId -> { user, card, volumeGainNode, isSelf }
        isJoined: false,
        isMuted: false,

        // Аудио стек
        audioContext: null,
        mediaStream: null,
        mediaSourceNode: null,
        audioWorkletNode: null,
        masterGainNode: null,

        // Воспроизведение и планировщик
        nextPlayTime: 0,
        volumeLevels: new Map(), // userId -> number [0.0 ... 2.0]
        masterVolume: 1.0,
        speakingThreshold: AUDIO_CONFIG.minVADThreshold,

        // Настройки микрофона
        echoCancellationEnabled: true,

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
        micSensitivity: document.getElementById('micSensitivity'),
        micSensitivityValue: document.getElementById('micSensitivityValue'),
        masterVolume: document.getElementById('masterVolume'),
        masterVolumeValue: document.getElementById('masterVolumeValue'),
        echoCancellation: document.getElementById('echoCancellation'),
        roomNameInput: document.getElementById('roomNameInput'),
        roomPasswordInput: document.getElementById('roomPasswordInput'),
        roomMaxUsersInput: document.getElementById('roomMaxUsersInput'),
        catInBagMode: document.getElementById('catInBagMode'),
        spatialAudioMode: document.getElementById('spatialAudioMode'),
        highQualityMode: document.getElementById('highQualityMode'),
        roomPasswordCheckInput: document.getElementById('roomPasswordCheckInput')
    };

    // =========================================================================
    // Инициализация приложения
    // =========================================================================
    document.addEventListener('DOMContentLoaded', () => {
        initUserProfile();
        bindUIEvents();
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

        if (dom.micSensitivity) {
            dom.micSensitivity.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                if (dom.micSensitivityValue) dom.micSensitivityValue.textContent = `${val}%`;
                state.speakingThreshold = (AUDIO_CONFIG.minVADThreshold * (200 - val)) / 100;
            });
        }

        if (dom.masterVolume) {
            dom.masterVolume.addEventListener('input', (e) => {
                const val = parseInt(e.target.value, 10);
                if (dom.masterVolumeValue) dom.masterVolumeValue.textContent = `${val}%`;
                setMasterVolume(val / 100);
            });
        }
    }

    // =========================================================================
    // Audio Core: Web Audio API & AudioWorklet Capture Pipeline
    // =========================================================================
    async function ensureAudioContext() {
        if (!state.audioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            state.audioContext = new AudioCtx({
                sampleRate: AUDIO_CONFIG.sampleRate,
                latencyHint: 'interactive'
            });

            state.masterGainNode = state.audioContext.createGain();
            state.masterGainNode.gain.value = state.masterVolume;
            state.masterGainNode.connect(state.audioContext.destination);

            // Регистрация инлайн-ворклета для захвата квантованного PCM 16-bit
            const workletCode = `
                class AudioCaptureProcessor extends AudioWorkletProcessor {
                    constructor() {
                        super();
                        this.bufferSize = 320; // 20ms @ 16kHz
                        this.buffer = new Float32Array(this.bufferSize);
                        this.bufferIdx = 0;
                    }

                    process(inputs, outputs, parameters) {
                        const input = inputs[0];
                        if (!input || input.length === 0) return true;
                        const channel = input[0];

                        for (let i = 0; i < channel.length; i++) {
                            this.buffer[this.bufferIdx++] = channel[i];
                            if (this.bufferIdx >= this.bufferSize) {
                                // Преобразование Float32 [-1.0, 1.0] -> Int16 Little-Endian
                                const int16 = new Int16Array(this.bufferSize);
                                for (let j = 0; j < this.bufferSize; j++) {
                                    const s = Math.max(-1, Math.min(1, this.buffer[j]));
                                    int16[j] = s < 0 ? s * 0x8000 : s * 0x7FFF;
                                }
                                this.port.postMessage(int16.buffer, [int16.buffer]);
                                this.bufferIdx = 0;
                            }
                        }
                        return true;
                    }
                }
                registerProcessor('audio-capture-processor', AudioCaptureProcessor);
            `;

            const blob = new Blob([workletCode], { type: 'application/javascript' });
            const workletUrl = URL.createObjectURL(blob);
            await state.audioContext.audioWorklet.addModule(workletUrl);
            URL.revokeObjectURL(workletUrl);
        }

        if (state.audioContext.state === 'suspended') {
            await state.audioContext.resume();
        }
    }

    async function startMicrophoneCapture() {
        await ensureAudioContext();
        stopMicrophoneCapture();

        try {
            state.mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    channelCount: AUDIO_CONFIG.channels,
                    sampleRate: AUDIO_CONFIG.sampleRate,
                    echoCancellation: state.echoCancellationEnabled,
                    // Отключаем тяжелые браузерные фильтры — очистка выполняется на Go-сервере
                    noiseSuppression: false,
                    autoGainControl: false
                },
                video: false
            });

            state.mediaSourceNode = state.audioContext.createMediaStreamSource(state.mediaStream);
            state.audioWorkletNode = new AudioWorkletNode(state.audioContext, 'audio-capture-processor');

            state.audioWorkletNode.port.onmessage = (event) => {
                if (!state.isJoined || state.isMuted) return;
                const pcmBuffer = event.data;

                // Быстрый локальный VAD для отображения собственного статуса говорения
                checkLocalSpeakingState(pcmBuffer);

                // Отправка бинарного фрейма на сервер Go
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(pcmBuffer);
                }
            };

            state.mediaSourceNode.connect(state.audioWorkletNode);
        } catch (err) {
            console.error('[VoiceChat] Failed to acquire microphone access:', err);
            throw err;
        }
    }

    function stopMicrophoneCapture() {
        if (state.audioWorkletNode) {
            state.audioWorkletNode.disconnect();
            state.audioWorkletNode.port.onmessage = null;
            state.audioWorkletNode = null;
        }

        if (state.mediaSourceNode) {
            state.mediaSourceNode.disconnect();
            state.mediaSourceNode = null;
        }

        if (state.mediaStream) {
            state.mediaStream.getTracks().forEach(track => {
                track.stop();
                track.enabled = false;
            });
            state.mediaStream = null;
        }

        if (state.user) {
            updateSpeakingUI(state.user.id, false);
        }
    }

    // =========================================================================
    // Воспроизведение аудиопотока с джиттер-буфером
    // =========================================================================
    function playIncomingAudioPacket(arrayBuffer) {
        if (!state.audioContext || arrayBuffer.byteLength < 2) return;

        // Формат пакета от Go-сервера:
        // [0..1] - Sender ID Length (uint16 big-endian) или 0 если это чистый серверный мастер-микс
        // [2..2+ID_LEN] - Sender ID string (если SFU режим)
        // [Остаток] - Int16 PCM Data

        const view = new DataView(arrayBuffer);
        let pcmOffset = 0;
        let speakerId = null;

        // Проверка наличия метаданных отправителя
        const idLen = view.getUint16(0, false);
        if (idLen > 0 && arrayBuffer.byteLength >= 2 + idLen + 2) {
            const idBytes = new Uint8Array(arrayBuffer, 2, idLen);
            speakerId = new TextDecoder().decode(idBytes);
            pcmOffset = 2 + idLen;
        } else {
            pcmOffset = 0; // Прямой Raw PCM микс
        }

        const rawByteLength = arrayBuffer.byteLength - pcmOffset;
        if (rawByteLength % 2 !== 0 || rawByteLength < 2) return;

        const sampleCount = rawByteLength / 2;
        const int16Samples = new Int16Array(arrayBuffer, pcmOffset, sampleCount);

        // Преобразование Int16 -> Float32
        const float32Samples = new Float32Array(sampleCount);
        let energySum = 0;
        for (let i = 0; i < sampleCount; i++) {
            const floatSample = int16Samples[i] / 32768.0;
            float32Samples[i] = floatSample;
            energySum += floatSample * floatSample;
        }

        // Обновление индикатора активности говорящего
        const rms = Math.sqrt(energySum / sampleCount);
        if (speakerId) {
            updateSpeakingUI(speakerId, rms > state.speakingThreshold);
        }

        // Создание буфера и планирование бесшовного воспроизведения
        const audioBuffer = state.audioContext.createBuffer(
            AUDIO_CONFIG.channels,
            sampleCount,
            AUDIO_CONFIG.sampleRate
        );
        audioBuffer.getChannelData(0).set(float32Samples);

        const sourceNode = state.audioContext.createBufferSource();
        sourceNode.buffer = audioBuffer;

        // Применение индивидуальной громкости участника при наличии speakerId
        let targetDestination = state.masterGainNode;
        if (speakerId && state.participants.has(speakerId)) {
            const p = state.participants.get(speakerId);
            if (p && p.volumeGainNode) {
                targetDestination = p.volumeGainNode;
            }
        }

        sourceNode.connect(targetDestination);

        // Джиттер-буфер и планирование времени старта
        const currentTime = state.audioContext.currentTime;
        const jitterBufferSec = AUDIO_CONFIG.jitterBufferMs / 1000.0;

        if (state.nextPlayTime < currentTime) {
            state.nextPlayTime = currentTime + jitterBufferSec;
        }

        sourceNode.start(state.nextPlayTime);
        state.nextPlayTime += audioBuffer.duration;
    }

    function checkLocalSpeakingState(int16ArrayBuffer) {
        if (!state.user) return;
        const int16 = new Int16Array(int16ArrayBuffer);
        let sum = 0;
        for (let i = 0; i < int16.length; i++) {
            const s = int16[i] / 32768.0;
            sum += s * s;
        }
        const rms = Math.sqrt(sum / int16.length);
        updateSpeakingUI(state.user.id, rms > state.speakingThreshold);
    }

    function setMasterVolume(value) {
        state.masterVolume = Math.max(0, Math.min(2, value));
        if (state.masterGainNode && state.audioContext) {
            state.masterGainNode.gain.setValueAtTime(state.masterVolume, state.audioContext.currentTime);
        }
    }

    // =========================================================================
    // WebSocket Transport & Signaling
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
                        playIncomingAudioPacket(event.data);
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

    function handleConnectionClose(event) {
        if (!state.isJoined) return;

        if (state.reconnectAttempts < state.maxReconnectAttempts) {
            state.reconnectAttempts++;
            const timeout = Math.min(1000 * Math.pow(1.5, state.reconnectAttempts), 5000);
            console.warn(`[VoiceChat] Connection lost. Reconnecting in ${Math.round(timeout)}ms (Attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts})...`);

            state.reconnectTimer = setTimeout(async () => {
                try {
                    await connectWebSocket();
                    sendJoinPayload();
                } catch (e) {
                    console.error('[VoiceChat] Reconnect failed:', e);
                }
            }, timeout);
        } else {
            alert('Связь с сервером потеряна. Пожалуйста, перезагрузите страницу или войдите снова.');
            leaveRoom();
        }
    }

    function sendSignaling(type, payload = {}) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type, payload }));
        } else {
            console.warn('[VoiceChat] Cannot send signaling message, socket not ready:', type);
        }
    }

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
                case 'room_created':
                    onRoomCreated(msg.payload);
                    break;
                case 'rooms_list':
                    onRoomsList(msg.payload);
                    break;
                case 'error':
                    onServerError(msg.payload);
                    break;
                default:
                    console.warn('[VoiceChat] Unknown signaling message type:', msg.type);
            }
        } catch (err) {
            console.error('[VoiceChat] Error parsing signaling payload:', err);
        }
    }

    // =========================================================================
    // Обработчики сигнальных сообщений
    // =========================================================================
    function onRoomState(payload) {
        clearParticipantsUI();
        if (Array.isArray(payload.users)) {
            payload.users.forEach(u => {
                const isSelf = Boolean(state.user && u.id === state.user.id);
                addParticipantToUI(u, isSelf);
            });
        }

        startMicrophoneCapture().catch(err => {
            console.warn('[VoiceChat] Auto-start microphone failed:', err);
        });

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
        }
    }

    function onUserMuted(payload) {
        const card = document.getElementById(`participant-${payload.userId}`);
        if (card) {
            if (payload.isMuted) card.classList.add('muted');
            else card.classList.remove('muted');
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
            const count = room.users ? (Array.isArray(room.users) ? room.users.length : Object.keys(room.users).length) : 0;
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
        const message = payload && payload.message ? payload.message : 'Неизвестная ошибка сервера';
        alert(`Ошибка: ${message}`);
        showRoomSelectionView();
    }

    // =========================================================================
    // Управление UI и комнатами
    // =========================================================================
    function showRoomSelectionView() {
        closeCreateRoomModal();
        closePasswordModal();
        stopMicrophoneCapture();

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
        if (state.isJoined) {
            dom.currentRoomLabel.textContent = `Комната: ${state.selectedRoomName}`;
        } else {
            dom.currentRoomLabel.textContent = state.selectedRoomName !== 'main'
                ? `Комната: ${state.selectedRoomName}`
                : 'Выберите комнату';
        }
    }

    async function joinRoom() {
        if (!state.user) initUserProfile();
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

        stopMicrophoneCapture();

        if (state.audioContext) {
            state.audioContext.close().catch(() => { });
            state.audioContext = null;
            state.masterGainNode = null;
        }

        state.isJoined = false;
        clearParticipantsUI();

        dom.participantsGrid.style.display = 'none';
        dom.footerControls.style.display = 'none';
        showRoomSelectionView();
    }

    function toggleMute() {
        state.isMuted = !state.isMuted;
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
            if (newName && state.user) {
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
                startMicrophoneCapture().catch(console.error);
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
            maxUsers: Math.min(10, Math.max(2, maxUsers)),
            catInBagMode: dom.catInBagMode ? dom.catInBagMode.checked : false,
            spatialAudioMode: dom.spatialAudioMode ? dom.spatialAudioMode.checked : false,
            highQualityMode: dom.highQualityMode ? dom.highQualityMode.checked : false
        };
        if (password) payload.password = password;

        try {
            await connectWebSocket();
            sendSignaling('create_room', payload);
            closeCreateRoomModal();
            if (dom.roomNameInput) dom.roomNameInput.value = '';
            if (dom.roomPasswordInput) dom.roomPasswordInput.value = '';
        } catch (err) {
            console.error('[VoiceChat] Failed to send create_room request:', err);
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
        } catch (err) {
            console.warn('[VoiceChat] Could not refresh rooms list:', err);
        }
    }

    // =========================================================================
    // Карточки участников (Grid & Volume Control)
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

        let volumeGainNode = null;

        if (!isSelf && state.audioContext && state.masterGainNode) {
            volumeGainNode = state.audioContext.createGain();
            const savedVol = state.volumeLevels.get(user.id) ?? 1.0;
            volumeGainNode.gain.value = savedVol;
            volumeGainNode.connect(state.masterGainNode);

            const volSlider = document.createElement('input');
            volSlider.type = 'range';
            volSlider.min = '0';
            volSlider.max = '200';
            volSlider.value = String(Math.round(savedVol * 100));
            volSlider.className = 'volume-control';
            volSlider.title = 'Громкость участника';

            volSlider.addEventListener('input', (e) => {
                const gain = parseInt(e.target.value, 10) / 100;
                state.volumeLevels.set(user.id, gain);
                if (volumeGainNode && state.audioContext) {
                    volumeGainNode.gain.setValueAtTime(gain, state.audioContext.currentTime);
                }
            });
            card.appendChild(volSlider);
        }

        if (dom.participantsGrid) {
            dom.participantsGrid.appendChild(card);
        }

        state.participants.set(user.id, { user, card, volumeGainNode, isSelf });
    }

    function removeParticipantFromUI(userId) {
        const participant = state.participants.get(userId);
        if (participant) {
            if (participant.card) participant.card.remove();
            if (participant.volumeGainNode) {
                try {
                    participant.volumeGainNode.disconnect();
                } catch (e) { }
            }
            state.participants.delete(userId);
        }
    }

    function clearParticipantsUI() {
        state.participants.forEach((p) => {
            if (p.volumeGainNode) {
                try {
                    p.volumeGainNode.disconnect();
                } catch (e) { }
            }
        });
        state.participants.clear();
        if (dom.participantsGrid) {
            dom.participantsGrid.innerHTML = '';
        }
    }

    function updateSpeakingUI(userId, isSpeaking) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            if (isSpeaking) card.classList.add('speaking');
            else card.classList.remove('speaking');
        }
    }

    // =========================================================================
    // Утилиты
    // =========================================================================
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