if (window.voiceChatApp) {
    console.warn('VoiceChat app already loaded');
} else {
    window.voiceChatApp = true;

    // ---------- Состояние ----------
    const state = {
        ws: null,
        user: null,
        participants: new Map(),
        isJoined: false,
        isMuted: false,
        audioContext: null,
        audioProcessor: null,
        microphoneStream: null,
        processingChain: [],
        reconnectAttempts: 0,
        maxReconnectAttempts: 3,
        volumeLevels: new Map(),
        speakingThreshold: 0.005,
        speakingUsers: new Set(),
        sampleRate: 48000,
        bufferSize: 2048,
        masterVolume: 1.0,
        noiseSuppressionEnabled: true,
        echoCancellationEnabled: true,
        pendingRoomId: null,
        pendingRoomName: null,
    };

    // ---------- DOM элементы ----------
    const elements = {
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
    };

    let selectedRoomId = 'main';
    let selectedRoomName = 'main';
    let currentRoomPassword = null;

    // ---------- Инициализация ----------
    document.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        setupSettingsListeners();
        loadUser();
        showRoomSelection();
    });

    function setupEventListeners() {
        if (elements.joinBtn) elements.joinBtn.addEventListener('click', joinRoom);
        if (elements.micBtn) elements.micBtn.addEventListener('click', toggleMute);
        if (elements.leaveBtn) elements.leaveBtn.addEventListener('click', leaveRoom);
        if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', openSettings);
        if (elements.closeSettingsBtn) elements.closeSettingsBtn.addEventListener('click', saveSettings);
        if (elements.createRoomBtn) elements.createRoomBtn.addEventListener('click', openCreateRoomModal);
        if (elements.refreshRoomsBtn) elements.refreshRoomsBtn.addEventListener('click', refreshRoomsList);
        if (elements.backToRoomsBtn) elements.backToRoomsBtn.addEventListener('click', showRoomSelection);
        if (elements.confirmCreateRoomBtn) elements.confirmCreateRoomBtn.addEventListener('click', confirmCreateRoom);
        if (elements.cancelCreateRoomBtn) elements.cancelCreateRoomBtn.addEventListener('click', closeCreateRoomModal);
        if (elements.confirmPasswordBtn) elements.confirmPasswordBtn.addEventListener('click', confirmPassword);
        if (elements.cancelPasswordBtn) elements.cancelPasswordBtn.addEventListener('click', closePasswordModal);
    }

    function setupSettingsListeners() {
        const micSensitivity = document.getElementById('micSensitivity');
        const micSensitivityValue = document.getElementById('micSensitivityValue');
        const masterVolume = document.getElementById('masterVolume');
        const masterVolumeValue = document.getElementById('masterVolumeValue');
        const noiseSuppression = document.getElementById('noiseSuppression');
        const echoCancellation = document.getElementById('echoCancellation');

        if (micSensitivity) {
            micSensitivity.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                if (micSensitivityValue) micSensitivityValue.textContent = value + '%';
                state.speakingThreshold = 0.005 * (200 - value) / 100;
            });
        }

        if (masterVolume) {
            masterVolume.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                if (masterVolumeValue) masterVolumeValue.textContent = value + '%';
                state.masterVolume = value / 100;
            });
        }

        // Значения будут применены при сохранении настроек
        if (noiseSuppression) {
            noiseSuppression.addEventListener('change', () => { });
        }
        if (echoCancellation) {
            echoCancellation.addEventListener('change', () => { });
        }
    }

    function loadUser() {
        let name = localStorage.getItem('voicechat_username');
        if (!name || !name.trim()) {
            name = prompt('Введите ваше имя для входа:');
            if (name && name.trim()) {
                localStorage.setItem('voicechat_username', name.trim());
            } else {
                name = 'Гость ' + Math.floor(Math.random() * 1000);
                localStorage.setItem('voicechat_username', name);
            }
        }
        state.user = {
            id: 'user_' + Math.random().toString(36).substring(2, 11),
            name: name,
            avatarColor: generateRandomColor()
        };
        if (elements.settingsUserName) {
            elements.settingsUserName.value = name;
        }
    }

    // ---------- Аудио ----------
    async function initAudioContext() {
        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: state.sampleRate,
                latencyHint: 'interactive'
            });
        }
        if (state.audioContext.state === 'suspended') {
            await state.audioContext.resume();
        }
    }

    async function initAudioProcessing() {
        if (!state.audioContext) await initAudioContext();
        state.processingChain = [];
        state.processingChain.push(...createEqualizer());
        state.processingChain.push(createCompressor());
        state.processingChain.push(createNoiseGate());
    }

    function createEqualizer() {
        const filters = [];
        const highpass = state.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 100;
        highpass.Q.value = 0.7;
        filters.push(highpass);
        const presence = state.audioContext.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 3000;
        presence.Q.value = 1.5;
        presence.gain.value = 4;
        filters.push(presence);
        return filters;
    }

    function createCompressor() {
        const compressor = state.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -25;
        compressor.knee.value = 15;
        compressor.ratio.value = 10;
        compressor.attack.value = 0.001;
        compressor.release.value = 0.08;
        return compressor;
    }

    function createNoiseGate() {
        const noiseGate = state.audioContext.createScriptProcessor(state.bufferSize, 1, 1);
        const threshold = 0.003;
        noiseGate.onaudioprocess = (event) => {
            const input = event.inputBuffer.getChannelData(0);
            const output = event.outputBuffer.getChannelData(0);
            let sum = 0;
            for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
            const rms = Math.sqrt(sum / input.length);
            if (rms < threshold) output.fill(0);
            else {
                const gain = Math.min(1, (rms - threshold) / threshold);
                for (let i = 0; i < input.length; i++) output[i] = input[i] * gain;
            }
        };
        return noiseGate;
    }

    async function startMicrophone() {
        await initAudioContext();

        state.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: state.echoCancellationEnabled,
                noiseSuppression: state.noiseSuppressionEnabled,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: state.sampleRate
            },
            video: false
        });

        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);

        // Фильтр высоких частот (убираем низкий гул)
        const highpass = state.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 80;
        highpass.Q.value = 0.7;

        // Усиление речевых частот
        const presence = state.audioContext.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 2500;
        presence.Q.value = 1.0;
        presence.gain.value = 3;

        // Компрессор для выравнивания громкости
        const compressor = state.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -20;
        compressor.knee.value = 10;
        compressor.ratio.value = 6;
        compressor.attack.value = 0.005;
        compressor.release.value = 0.1;

        // Создаём обработчик
        state.audioProcessor = state.audioContext.createScriptProcessor(state.bufferSize, 1, 1);

        state.audioProcessor.onaudioprocess = (event) => {
            if (!state.isJoined || state.isMuted) return;

            const audioData = event.inputBuffer.getChannelData(0);
            const pcmData = floatToPCM16Optimized(audioData);

            if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                state.ws.send(pcmData);
            }
        };

        // Подключаем цепочку
        source.connect(highpass);
        highpass.connect(presence);
        presence.connect(compressor);
        compressor.connect(state.audioProcessor);
        state.audioProcessor.connect(state.audioContext.destination);
    }

    function floatToPCM16Optimized(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    function processPCMData(userId, pcmData) {
        if (!state.audioContext) return;

        const dataArray = new Uint8Array(pcmData);
        // Проверяем, что данных достаточно (минимум 2 байта для одного сэмпла)
        if (dataArray.length < 2) {
            return;
        }

        // Обрезаем до чётного количества байт
        let byteLength = dataArray.length;
        if (byteLength % 2 !== 0) {
            byteLength--;
        }
        if (byteLength < 2) return;

        // Используем только чётную часть
        const int16Array = new Int16Array(dataArray.buffer, dataArray.byteOffset, byteLength / 2);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const rms = Math.sqrt(float32Array.reduce((sum, val) => sum + val * val, 0) / float32Array.length);
        if (rms > state.speakingThreshold) {
            state.speakingUsers.add(userId);
            updateSpeakingIndicator(userId, true);
        } else {
            state.speakingUsers.delete(userId);
            updateSpeakingIndicator(userId, false);
        }

        const volume = (state.volumeLevels.get(userId) || 1.0) * state.masterVolume;
        const audioBuffer = state.audioContext.createBuffer(1, float32Array.length, state.sampleRate);
        audioBuffer.getChannelData(0).set(float32Array);
        const source = state.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        const gainNode = state.audioContext.createGain();
        gainNode.gain.value = volume;
        source.connect(gainNode);
        gainNode.connect(state.audioContext.destination);
        source.start();
    }

    function playRemoteAudio(userId, data) {
        if (!state.audioContext) return;

        const dataArray = new Uint8Array(data);
        if (dataArray.length < 2) return;
        if (dataArray[0] === 0) return;

        let pcmBytes;
        if (dataArray[0] === 1 && dataArray.length >= 3) {
            const len = (dataArray[1] << 8) | dataArray[2];
            pcmBytes = dataArray.slice(3, 3 + len);
        } else {
            pcmBytes = dataArray;
        }

        if (pcmBytes.length % 2 !== 0) {
            pcmBytes = pcmBytes.slice(0, pcmBytes.length - 1);
        }
        if (pcmBytes.length < 2) return;

        const int16Array = new Int16Array(pcmBytes.buffer, pcmBytes.byteOffset, pcmBytes.length / 2);
        const float32Array = new Float32Array(int16Array.length);
        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        // Определяем RMS
        let sum = 0;
        for (let i = 0; i < float32Array.length; i++) {
            sum += float32Array[i] * float32Array[i];
        }
        const rms = Math.sqrt(sum / float32Array.length);

        // Обновляем индикатор
        if (rms > 0.01) {
            updateSpeakingIndicator(userId, true);
        } else {
            updateSpeakingIndicator(userId, false);
        }

        const volume = (state.volumeLevels.get(userId) || 1.0) * state.masterVolume;
        const audioBuffer = state.audioContext.createBuffer(1, float32Array.length, state.sampleRate);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = state.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        const gainNode = state.audioContext.createGain();
        gainNode.gain.value = volume;
        source.connect(gainNode);
        gainNode.connect(state.audioContext.destination);
        source.start();
    }

    function updateSpeakingIndicator(userId, isSpeaking) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            if (isSpeaking) card.classList.add('speaking');
            else card.classList.remove('speaking');
        }
    }

    function stopMicrophone() {
        if (state.audioProcessor) {
            state.audioProcessor.disconnect();
            state.audioProcessor.onaudioprocess = null;
            state.audioProcessor = null;
        }
        state.processingChain = [];
        if (state.microphoneStream) {
            state.microphoneStream.getTracks().forEach(track => {
                track.stop();
                track.enabled = false;
            });
            state.microphoneStream = null;
        }
    }

    // ---------- WebSocket ----------
    function connectWebSocket() {
        if (state.ws && (state.ws.readyState === WebSocket.OPEN || state.ws.readyState === WebSocket.CONNECTING)) {
            return Promise.resolve();
        }
        return new Promise((resolve, reject) => {
            const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            const wsUrl = `${protocol}//${window.location.host}/ws`;
            state.ws = new WebSocket(wsUrl);
            state.ws.binaryType = 'arraybuffer';
            state.ws.onopen = () => {
                console.log('WebSocket connected');
                resolve();
            };
            state.ws.onmessage = (event) => {
                if (typeof event.data === 'string') handleJSONMessage(event.data);
                else if (event.data instanceof ArrayBuffer) playRemoteAudio(null, event.data);
            };
            state.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };
            state.ws.onclose = () => {
                console.log('WebSocket disconnected');
                if (state.isJoined) leaveRoom();
                state.ws = null;
            };
        });
    }

    function sendJSONMessage(type, payload) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type, payload }));
        } else {
            console.warn('WebSocket not ready');
        }
    }

    // ---------- Обработка сообщений ----------
    function handleJSONMessage(data) {
        try {
            const message = JSON.parse(data);
            switch (message.type) {
                case 'room_state':
                    handleRoomState(message.payload);
                    break;
                case 'user_joined':
                    handleUserJoined(message.payload);
                    break;
                case 'user_left':
                    handleUserLeft(message.payload);
                    break;
                case 'room_created':
                    handleRoomCreated(message.payload);
                    break;
                case 'rooms_list':
                    handleRoomsList(message.payload);
                    break;
                case 'error':
                    console.error('Server error:', message.payload.message);
                    alert('Ошибка: ' + message.payload.message);
                    showRoomSelection();
                    break;
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    function handleRoomState(payload) {
        if (payload.users) {
            state.participants.clear();
            document.querySelectorAll('.participant-card').forEach(c => c.remove());
            payload.users.forEach(user => {
                if (state.user && user.id === state.user.id) addParticipantToUI(user, true);
                else addParticipantToUI(user, false);
            });
            startMicrophone().catch(err => console.error('Mic start failed:', err));
            state.isJoined = true;
            elements.connectionPanel.style.display = 'none';
            elements.participantsGrid.style.display = 'grid';
            elements.footerControls.style.display = 'flex';
            updateRoomLabel();
        }
    }

    function handleUserJoined(payload) {
        if (payload.user && state.user && payload.user.id !== state.user.id) {
            addParticipantToUI(payload.user, false);
        }
    }

    function handleUserLeft(payload) {
        const participant = state.participants.get(payload.userId);
        if (participant) {
            participant.card.remove();
            state.participants.delete(payload.userId);
        }
    }

    function handleRoomCreated(payload) {
        if (payload.room) {
            selectedRoomId = payload.room.id;
            selectedRoomName = payload.room.name;
            currentRoomPassword = payload.room.password || null;
            updateRoomLabel();
            refreshRoomsList();
            selectRoom(selectedRoomId, selectedRoomName);
        }
    }

    function handleRoomsList(payload) {
        if (!payload.rooms || !elements.roomsList) return;
        elements.roomsList.innerHTML = '';
        payload.rooms.forEach(room => {
            const roomCard = document.createElement('div');
            roomCard.className = 'room-card';
            const roomInfo = document.createElement('div');
            roomInfo.className = 'room-card-info';
            const roomName = document.createElement('div');
            roomName.className = 'room-card-name';
            roomName.textContent = room.name;
            const userCount = document.createElement('div');
            userCount.className = 'room-card-users';
            const count = room.users ? Object.keys(room.users).length : 0;
            userCount.textContent = `👥 ${count} участников`;
            roomInfo.appendChild(roomName);
            roomInfo.appendChild(userCount);
            const lockIcon = document.createElement('span');
            lockIcon.className = 'room-card-lock';
            lockIcon.textContent = room.password ? '🔒' : '';
            roomCard.appendChild(roomInfo);
            roomCard.appendChild(lockIcon);
            roomCard.addEventListener('click', () => {
                if (room.password) {
                    openPasswordModal(room.id, room.name);
                } else {
                    selectRoom(room.id, room.name);
                }
            });
            elements.roomsList.appendChild(roomCard);
        });
    }

    // ---------- UI действия ----------
    function showRoomSelection() {
        elements.createRoomModal.style.display = 'none';
        elements.passwordModal.style.display = 'none';
        stopMicrophone();
        state.isJoined = false;
        state.participants.clear();
        document.querySelectorAll('.participant-card').forEach(c => c.remove());
        elements.roomSelectionPanel.style.display = 'block';
        elements.connectionPanel.style.display = 'none';
        elements.participantsGrid.style.display = 'none';
        elements.footerControls.style.display = 'none';
        selectedRoomId = 'main';
        selectedRoomName = 'main';
        currentRoomPassword = null;
        updateRoomLabel();
        refreshRoomsList();
    }

    function selectRoom(roomId, roomName) {
        selectedRoomId = roomId;
        selectedRoomName = roomName;
        updateRoomLabel();
        elements.roomSelectionPanel.style.display = 'none';
        elements.connectionPanel.style.display = 'block';
        if (elements.selectedRoomInfo) {
            elements.selectedRoomInfo.innerHTML = `<strong>Комната:</strong> ${roomName}<br><small>Нажмите "Присоединиться"</small>`;
        }
    }

    function updateRoomLabel() {
        if (elements.currentRoomLabel) {
            elements.currentRoomLabel.textContent = state.isJoined
                ? `Комната: ${selectedRoomName}`
                : (selectedRoomName !== 'main' ? `Комната: ${selectedRoomName}` : 'Выберите комнату');
        }
    }

    async function joinRoom() {
        if (!state.user) loadUser();
        try {
            await connectWebSocket();
        } catch (e) {
            alert('Не удалось подключиться к серверу');
            return;
        }
        const joinPayload = {
            userId: state.user.id,
            userName: state.user.name,
            avatarColor: state.user.avatarColor,
            roomId: selectedRoomId,
        };
        if (currentRoomPassword) joinPayload.password = currentRoomPassword;
        sendJSONMessage('join', joinPayload);
    }

    function leaveRoom() {
        // Полностью останавливаем микрофон
        stopMicrophone();

        // Останавливаем все аудио
        if (state.audioContext) {
            state.audioContext.close().catch(() => { });
            state.audioContext = null;
        }

        state.isJoined = false;
        state.participants.clear();
        document.querySelectorAll('.participant-card').forEach(c => c.remove());
        elements.participantsGrid.style.display = 'none';
        elements.footerControls.style.display = 'none';
        showRoomSelection();
    }

    function toggleMute() {
        if (!state.microphoneStream) return;
        state.isMuted = !state.isMuted;
        sendJSONMessage('mute', { isMuted: state.isMuted });
        elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
    }

    function openSettings() {
        if (elements.settingsUserName) {
            elements.settingsUserName.value = state.user ? state.user.name : localStorage.getItem('voicechat_username') || '';
        }
        elements.settingsModal.style.display = 'flex';
    }

    function saveSettings() {
        // Сохраняем имя
        if (elements.settingsUserName) {
            const newName = elements.settingsUserName.value.trim();
            if (newName) {
                localStorage.setItem('voicechat_username', newName);
                if (state.user) state.user.name = newName;
            }
        }
        // Применяем настройки, даже если пользователь не в комнате
        const noiseSuppression = document.getElementById('noiseSuppression');
        const echoCancellation = document.getElementById('echoCancellation');
        if (noiseSuppression) state.noiseSuppressionEnabled = noiseSuppression.checked;
        if (echoCancellation) state.echoCancellationEnabled = echoCancellation.checked;
        elements.settingsModal.style.display = 'none';
        // Если пользователь в комнате, перезапускаем микрофон
        if (state.isJoined) {
            stopMicrophone();
            startMicrophone().catch(err => console.error('Mic restart failed:', err));
        }
    }

    function openCreateRoomModal() {
        elements.createRoomModal.style.display = 'flex';
    }

    function closeCreateRoomModal() {
        elements.createRoomModal.style.display = 'none';
    }

    function confirmCreateRoom() {
        const roomName = document.getElementById('roomNameInput').value.trim();
        if (!roomName) {
            alert('Введите название комнаты');
            return;
        }
        const password = document.getElementById('roomPasswordInput').value;
        const maxUsers = parseInt(document.getElementById('roomMaxUsersInput').value) || 25;
        const catInBagMode = document.getElementById('catInBagMode').checked;
        const spatialAudioMode = document.getElementById('spatialAudioMode').checked;
        const highQualityMode = document.getElementById('highQualityMode').checked;

        const payload = {
            roomName,
            maxUsers,
            catInBagMode,
            spatialAudioMode,
            highQualityMode
        };
        if (password) payload.password = password;

        connectWebSocket().then(() => {
            sendJSONMessage('create_room', payload);
        }).catch(err => console.error('WS error during create room:', err));

        closeCreateRoomModal();
        document.getElementById('roomNameInput').value = '';
        document.getElementById('roomPasswordInput').value = '';
    }

    function openPasswordModal(roomId, roomName) {
        state.pendingRoomId = roomId;
        state.pendingRoomName = roomName;
        elements.passwordModal.style.display = 'flex';
    }

    function closePasswordModal() {
        elements.passwordModal.style.display = 'none';
        state.pendingRoomId = null;
        state.pendingRoomName = null;
    }

    function confirmPassword() {
        const passwordInput = document.getElementById('roomPasswordCheckInput');
        if (!passwordInput) return;
        const password = passwordInput.value;
        if (state.pendingRoomId) {
            selectedRoomId = state.pendingRoomId;
            selectedRoomName = state.pendingRoomName;
            currentRoomPassword = password;
            selectRoom(selectedRoomId, selectedRoomName);
        }
        closePasswordModal();
        passwordInput.value = '';
    }

    async function refreshRoomsList() {
        try {
            await connectWebSocket();
            sendJSONMessage('get_rooms', {});
        } catch (e) {
            console.error('Failed to refresh rooms:', e);
        }
    }

    function addParticipantToUI(user, isSelf = false) {
        if (state.participants.has(user.id)) return;
        const card = document.createElement('div');
        card.className = 'participant-card glass';
        card.id = `participant-${user.id}`;
        const avatar = document.createElement('div');
        avatar.className = 'avatar';
        avatar.style.background = user.avatarColor || generateRandomColor();
        avatar.textContent = (user.name || 'U').charAt(0).toUpperCase();
        const name = document.createElement('div');
        name.className = 'participant-name';
        name.textContent = isSelf ? `${user.name} (Вы)` : user.name;
        card.appendChild(avatar);
        card.appendChild(name);
        if (!isSelf) {
            const volumeControl = document.createElement('input');
            volumeControl.type = 'range';
            volumeControl.min = '0';
            volumeControl.max = '200';
            volumeControl.value = '100';
            volumeControl.className = 'volume-control';
            volumeControl.addEventListener('input', (e) => {
                const volume = parseInt(e.target.value) / 100;
                state.volumeLevels.set(user.id, volume);
            });
            card.appendChild(volumeControl);
        }
        elements.participantsGrid.appendChild(card);
        state.participants.set(user.id, { user, card, isSelf });
    }

    function generateRandomColor() {
        const colors = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b'];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}