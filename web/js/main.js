if (window.voiceChatApp) {
    console.warn('VoiceChat app already loaded');
} else {
    window.voiceChatApp = true;

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
        echoCancellationEnabled: true
    };

    let selectedRoomId = 'main';
    let selectedRoomName = 'main';
    let currentRoomPassword = null;
    let pendingRoomId = null;

    const elements = {
        connectionPanel: document.getElementById('connectionPanel'),
        participantsGrid: document.getElementById('participantsGrid'),
        joinBtn: document.getElementById('joinBtn'),
        micBtn: document.getElementById('micBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        settingsBtn: document.getElementById('settingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn')
    };

    const roomElements = {
        roomSelectionPanel: document.getElementById('roomSelectionPanel'),
        roomsList: document.getElementById('roomsList'),
        createRoomBtn: document.getElementById('createRoomBtn'),
        refreshRoomsBtn: document.getElementById('refreshRoomsBtn'),
        selectedRoomInfo: document.getElementById('selectedRoomInfo'),
        backToRoomsBtn: document.getElementById('backToRoomsBtn'),
        footerControls: document.getElementById('footerControls')
    };

    document.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        setupSettingsListeners();
        checkUserExists();
    });

    function setupEventListeners() {
        if (elements.joinBtn) elements.joinBtn.addEventListener('click', joinRoom);
        if (elements.micBtn) elements.micBtn.addEventListener('click', toggleMute);
        if (elements.leaveBtn) elements.leaveBtn.addEventListener('click', leaveRoom);
        if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', openSettings);
        if (elements.closeSettingsBtn) elements.closeSettingsBtn.addEventListener('click', saveSettings);

        if (roomElements.createRoomBtn) {
            roomElements.createRoomBtn.addEventListener('click', openCreateRoomModal);
        }
        if (roomElements.refreshRoomsBtn) {
            roomElements.refreshRoomsBtn.addEventListener('click', refreshRoomsList);
        }
        if (roomElements.backToRoomsBtn) {
            roomElements.backToRoomsBtn.addEventListener('click', showRoomSelection);
        }

        const confirmCreateRoomBtn = document.getElementById('confirmCreateRoomBtn');
        const cancelCreateRoomBtn = document.getElementById('cancelCreateRoomBtn');
        const confirmPasswordBtn = document.getElementById('confirmPasswordBtn');
        const cancelPasswordBtn = document.getElementById('cancelPasswordBtn');

        if (confirmCreateRoomBtn) confirmCreateRoomBtn.addEventListener('click', confirmCreateRoom);
        if (cancelCreateRoomBtn) cancelCreateRoomBtn.addEventListener('click', closeCreateRoomModal);
        if (confirmPasswordBtn) confirmPasswordBtn.addEventListener('click', confirmPassword);
        if (cancelPasswordBtn) cancelPasswordBtn.addEventListener('click', closePasswordModal);
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

        if (noiseSuppression) {
            noiseSuppression.addEventListener('change', (e) => {
                state.noiseSuppressionEnabled = e.target.checked;
            });
        }

        if (echoCancellation) {
            echoCancellation.addEventListener('change', (e) => {
                state.echoCancellationEnabled = e.target.checked;
            });
        }
    }

    function checkUserExists() {
        const savedName = localStorage.getItem('voicechat_username');
        const settingsUserName = document.getElementById('settingsUserName');

        if (savedName && settingsUserName) {
            settingsUserName.value = savedName;
        }

        // Если имя не сохранено, показываем модальное окно
        if (!savedName) {
            const userName = prompt('Введите ваше имя для входа:');
            if (userName && userName.trim()) {
                localStorage.setItem('voicechat_username', userName.trim());
                if (settingsUserName) settingsUserName.value = userName.trim();
            }
        }
    }

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
        if (!state.audioContext) {
            await initAudioContext();
        }
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
            for (let i = 0; i < input.length; i++) {
                sum += input[i] * input[i];
            }
            const rms = Math.sqrt(sum / input.length);

            if (rms < threshold) {
                output.fill(0);
            } else {
                const gain = Math.min(1, (rms - threshold) / threshold);
                for (let i = 0; i < input.length; i++) {
                    output[i] = input[i] * gain;
                }
            }
        };

        return noiseGate;
    }

    async function startMicrophone() {
        await initAudioProcessing();

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
        let currentNode = source;

        for (const processor of state.processingChain) {
            currentNode.connect(processor);
            currentNode = processor;
        }

        const analyser = state.audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        currentNode.connect(analyser);

        state.audioProcessor = state.audioContext.createScriptProcessor(state.bufferSize, 1, 1);

        state.audioProcessor.onaudioprocess = (event) => {
            if (!state.isJoined || state.isMuted) return;

            const audioData = event.inputBuffer.getChannelData(0);
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(dataArray);

            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const value = (dataArray[i] - 128) / 128;
                sum += value * value;
            }
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms < state.speakingThreshold) {
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(new Uint8Array([0]));
                }
            } else {
                const pcmData = floatToPCM16Optimized(audioData);
                const header = new Uint8Array(3);
                header[0] = 1;
                header[1] = (pcmData.byteLength >> 8) & 0xFF;
                header[2] = pcmData.byteLength & 0xFF;

                const combined = new Uint8Array(header.length + pcmData.byteLength);
                combined.set(header);
                combined.set(new Uint8Array(pcmData), header.length);

                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(combined.buffer);
                }
            }
        };

        analyser.connect(state.audioProcessor);
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

    function playRemoteAudio(userId, data) {
        if (!state.audioContext) return;

        const dataArray = new Uint8Array(data);

        if (dataArray[0] === 0) {
            state.speakingUsers.delete(userId);
            updateSpeakingIndicator(userId, false);
            return;
        }

        if (dataArray[0] === 1) {
            const length = (dataArray[1] << 8) | dataArray[2];
            const pcmData = dataArray.slice(3, 3 + length);

            const int16Array = new Int16Array(pcmData.buffer);
            const float32Array = new Float32Array(int16Array.length);

            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768.0;
            }

            const rms = Math.sqrt(float32Array.reduce((sum, val) => sum + val * val, 0) / float32Array.length);
            if (rms > state.speakingThreshold) {
                state.speakingUsers.add(userId);
                updateSpeakingIndicator(userId, true);
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
    }

    function updateSpeakingIndicator(userId, isSpeaking) {
        const card = document.getElementById(`participant-${userId}`);
        if (card) {
            if (isSpeaking) {
                card.classList.add('speaking');
            } else {
                card.classList.remove('speaking');
            }
        }
    }

    function stopMicrophone() {
        if (state.audioProcessor) {
            state.audioProcessor.disconnect();
            state.audioProcessor = null;
        }
        state.processingChain = [];
        if (state.microphoneStream) {
            state.microphoneStream.getTracks().forEach(track => track.stop());
            state.microphoneStream = null;
        }
    }

    async function joinRoom() {
        const savedName = localStorage.getItem('voicechat_username');

        if (!savedName || !savedName.trim()) {
            alert('Пожалуйста, введите ваше имя в настройках');
            openSettings();
            return;
        }

        state.user = {
            id: 'user_' + Math.random().toString(36).substring(2, 11),
            name: savedName,
            avatarColor: generateRandomColor()
        };

        try {
            await startMicrophone();
            await connectWebSocket();

            const joinPayload = {
                userId: state.user.id,
                userName: state.user.name,
                avatarColor: state.user.avatarColor,
                roomId: selectedRoomId || 'main'
            };

            if (currentRoomPassword) {
                joinPayload.password = currentRoomPassword;
            }

            sendJSONMessage('join', joinPayload);

            elements.connectionPanel.style.display = 'none';
            elements.participantsGrid.style.display = 'grid';
            if (roomElements.footerControls) {
                roomElements.footerControls.style.display = 'flex';
            }

            addParticipantToUI(state.user, true);
            state.isJoined = true;

        } catch (error) {
            console.error('Failed to join room:', error);
            alert('Ошибка: ' + error.message);
        }
    }

    async function connectWebSocket() {
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
                if (typeof event.data === 'string') {
                    handleJSONMessage(event.data);
                } else if (event.data instanceof ArrayBuffer) {
                    playRemoteAudio('remote', event.data);
                }
            };

            state.ws.onerror = (error) => {
                console.error('WebSocket error:', error);
                reject(error);
            };

            state.ws.onclose = () => {
                console.log('WebSocket disconnected');
                if (state.isJoined) {
                    leaveRoom();
                }
            };
        });
    }

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
                    break;
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    function handleRoomState(payload) {
        if (payload.users) {
            payload.users.forEach(user => {
                if (state.user && user.id !== state.user.id) {
                    addParticipantToUI(user, false);
                }
            });
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

            const currentRoomLabel = document.getElementById('currentRoomLabel');
            if (currentRoomLabel) {
                currentRoomLabel.textContent = `Комната: ${payload.room.name}`;
            }

            refreshRoomsList();
        }
    }

    function handleRoomsList(payload) {
        if (!payload.rooms || !roomElements.roomsList) return;

        roomElements.roomsList.innerHTML = '';

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
                    openPasswordModal(room.id);
                } else {
                    selectRoom(room.id, room.name);
                }
            });

            roomElements.roomsList.appendChild(roomCard);
        });
    }

    function selectRoom(roomId, roomName) {
        selectedRoomId = roomId;
        selectedRoomName = roomName || roomId;
        currentRoomPassword = null;

        const currentRoomLabel = document.getElementById('currentRoomLabel');
        if (currentRoomLabel) {
            currentRoomLabel.textContent = `Комната: ${selectedRoomName}`;
        }

        if (roomElements.roomSelectionPanel) {
            roomElements.roomSelectionPanel.style.display = 'none';
        }
        if (elements.connectionPanel) {
            elements.connectionPanel.style.display = 'block';
        }

        if (roomElements.selectedRoomInfo) {
            roomElements.selectedRoomInfo.innerHTML = `<strong>Комната:</strong> ${selectedRoomName}<br><small>Нажмите "Присоединиться"</small>`;
        }
    }

    function showRoomSelection() {
        if (state.ws) {
            state.ws.close();
            state.ws = null;
        }

        stopMicrophone();

        state.isJoined = false;
        state.user = null;
        state.participants.clear();

        const currentRoomLabel = document.getElementById('currentRoomLabel');
        if (currentRoomLabel) {
            currentRoomLabel.textContent = 'Выберите комнату';
        }

        if (elements.connectionPanel) elements.connectionPanel.style.display = 'none';
        if (elements.participantsGrid) elements.participantsGrid.style.display = 'none';
        if (elements.participantsGrid) elements.participantsGrid.innerHTML = '';
        if (roomElements.footerControls) roomElements.footerControls.style.display = 'none';
        if (roomElements.roomSelectionPanel) roomElements.roomSelectionPanel.style.display = 'block';

        refreshRoomsList();
    }

    async function refreshRoomsList() {
        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            await connectWebSocket();
        }
        sendJSONMessage('get_rooms', {});
    }

    function openCreateRoomModal() {
        document.getElementById('createRoomModal').style.display = 'flex';
    }

    function closeCreateRoomModal() {
        document.getElementById('createRoomModal').style.display = 'none';
    }

    function confirmCreateRoom() {
        const roomName = document.getElementById('roomNameInput').value.trim();
        const password = document.getElementById('roomPasswordInput').value;
        const maxUsers = parseInt(document.getElementById('roomMaxUsersInput').value) || 25;
        const catInBagMode = document.getElementById('catInBagMode').checked;
        const spatialAudioMode = document.getElementById('spatialAudioMode').checked;
        const highQualityMode = document.getElementById('highQualityMode').checked;

        if (!roomName) {
            alert('Введите название комнаты');
            return;
        }

        const payload = {
            roomName: roomName,
            maxUsers: maxUsers,
            catInBagMode: catInBagMode,
            spatialAudioMode: spatialAudioMode,
            highQualityMode: highQualityMode
        };

        if (password) {
            payload.password = password;
        }

        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            connectWebSocket().then(() => {
                sendJSONMessage('create_room', payload);
            });
        } else {
            sendJSONMessage('create_room', payload);
        }

        closeCreateRoomModal();
        document.getElementById('roomNameInput').value = '';
        document.getElementById('roomPasswordInput').value = '';
    }

    function openPasswordModal(roomId) {
        pendingRoomId = roomId;
        document.getElementById('passwordModal').style.display = 'flex';
    }

    function closePasswordModal() {
        pendingRoomId = null;
        document.getElementById('passwordModal').style.display = 'none';
    }

    function confirmPassword() {
        const password = document.getElementById('roomPasswordCheckInput').value;

        if (pendingRoomId) {
            currentRoomPassword = password;
            selectRoom(pendingRoomId, pendingRoomId);
        }

        closePasswordModal();
        document.getElementById('roomPasswordCheckInput').value = '';
    }

    function sendJSONMessage(type, payload) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type, payload }));
        }
    }

    function leaveRoom() {
        if (state.ws) {
            state.ws.close();
            state.ws = null;
        }

        stopMicrophone();

        state.participants.clear();
        state.isJoined = false;
        state.user = null;

        const currentRoomLabel = document.getElementById('currentRoomLabel');
        if (currentRoomLabel) {
            currentRoomLabel.textContent = 'Выберите комнату';
        }

        if (elements.connectionPanel) elements.connectionPanel.style.display = 'block';
        if (elements.participantsGrid) elements.participantsGrid.style.display = 'none';
        if (elements.participantsGrid) elements.participantsGrid.innerHTML = '';
        if (roomElements.footerControls) roomElements.footerControls.style.display = 'none';

        showRoomSelection();
    }

    function toggleMute() {
        if (!state.microphoneStream) return;

        state.isMuted = !state.isMuted;

        sendJSONMessage('mute', {
            isMuted: state.isMuted
        });

        if (elements.micBtn) {
            elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
        }
    }

    function openSettings() {
        const settingsUserName = document.getElementById('settingsUserName');
        const savedName = localStorage.getItem('voicechat_username');
        if (settingsUserName && savedName) {
            settingsUserName.value = savedName;
        }

        if (elements.settingsModal) {
            elements.settingsModal.style.display = 'flex';
        }
    }

    function saveSettings() {
        const settingsUserName = document.getElementById('settingsUserName');
        if (settingsUserName) {
            const newName = settingsUserName.value.trim();
            if (newName) {
                localStorage.setItem('voicechat_username', newName);
            }
        }

        if (elements.settingsModal) {
            elements.settingsModal.style.display = 'none';
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