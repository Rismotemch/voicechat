// Глобальное состояние
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
        bitrate: 64000, // 64 kbps для Opus
        sampleRate: 48000,
        bufferSize: 960 // 20ms при 48kHz
    };

    // Выбор комнаты
    let selectedRoomId = null;
    let selectedRoomName = null;

    // DOM элементы для комнат
    const roomElements = {
        roomSelectionPanel: document.getElementById('roomSelectionPanel'),
        roomsList: document.getElementById('roomsList'),
        newRoomName: document.getElementById('newRoomName'),
        createRoomBtn: document.getElementById('createRoomBtn'),
        selectedRoomInfo: document.getElementById('selectedRoomInfo'),
        backToRoomsBtn: document.getElementById('backToRoomsBtn'),
        footerControls: document.getElementById('footerControls')
    };

    // Добавим обработчики
    if (roomElements.createRoomBtn) {
        roomElements.createRoomBtn.addEventListener('click', createRoom);
    }
    if (roomElements.backToRoomsBtn) {
        roomElements.backToRoomsBtn.addEventListener('click', showRoomSelection);
    }

    // Функции для работы с комнатами
    function showRoomSelection() {
        elements.connectionPanel.style.display = 'none';
        elements.participantsGrid.style.display = 'none';
        roomElements.footerControls.style.display = 'none';
        roomElements.roomSelectionPanel.style.display = 'block';

        // Запрашиваем список комнат
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            sendJSONMessage('get_rooms', {});
        }
    }

    function selectRoom(roomId, roomName) {
        selectedRoomId = roomId;
        selectedRoomName = roomName;

        roomElements.roomSelectionPanel.style.display = 'none';
        elements.connectionPanel.style.display = 'block';

        if (roomElements.selectedRoomInfo) {
            roomElements.selectedRoomInfo.innerHTML = `<strong>Комната:</strong> ${roomName}`;
        }
    }

    async function createRoom() {
        const roomName = roomElements.newRoomName.value.trim();
        if (!roomName) {
            alert('Введите название комнаты');
            return;
        }

        if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
            // Подключаемся к WebSocket если не подключены
            await connectWebSocket();
        }

        sendJSONMessage('create_room', {
            roomName: roomName,
            maxUsers: 25
        });

        roomElements.newRoomName.value = '';
    }

    function handleRoomCreated(payload) {
        console.log('Room created:', payload.room);
        // Обновляем список комнат
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            sendJSONMessage('get_rooms', {});
        }
    }

    function handleRoomsList(payload) {
        if (!payload.rooms || !roomElements.roomsList) return;

        roomElements.roomsList.innerHTML = '';

        payload.rooms.forEach(room => {
            const roomCard = document.createElement('div');
            roomCard.className = 'room-card';

            const roomName = document.createElement('div');
            roomName.className = 'room-name';
            roomName.textContent = room.name;

            const userCount = document.createElement('div');
            userCount.className = 'room-users';
            userCount.textContent = `👥 ${room.users ? Object.keys(room.users).length : 0} участников`;

            roomCard.appendChild(roomName);
            roomCard.appendChild(userCount);

            roomCard.addEventListener('click', () => {
                selectRoom(room.id, room.name);
            });

            roomElements.roomsList.appendChild(roomCard);
        });
    }

    // Настройки
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
                micSensitivityValue.textContent = value + '%';

                // Применяем чувствительность микрофона
                if (state.audioContext && state.compressor) {
                    state.compressor.threshold.value = -30 + (value - 100) * 0.1;
                }
            });
        }

        if (masterVolume) {
            masterVolume.addEventListener('input', (e) => {
                const value = parseInt(e.target.value);
                masterVolumeValue.textContent = value + '%';

                // Применяем общую громкость
                state.masterVolume = value / 100;
            });
        }

        if (noiseSuppression) {
            noiseSuppression.addEventListener('change', (e) => {
                state.noiseSuppressionEnabled = e.target.checked;
                // Перезапускаем микрофон с новыми настройками
                if (state.isJoined) {
                    stopMicrophone();
                    startMicrophone();
                }
            });
        }

        if (echoCancellation) {
            echoCancellation.addEventListener('change', (e) => {
                state.echoCancellationEnabled = e.target.checked;
                // Перезапускаем микрофон с новыми настройками
                if (state.isJoined) {
                    stopMicrophone();
                    startMicrophone();
                }
            });
        }
    }

    const elements = {
        connectionPanel: document.getElementById('connectionPanel'),
        participantsGrid: document.getElementById('participantsGrid'),
        joinBtn: document.getElementById('joinBtn'),
        userName: document.getElementById('userName'),
        micBtn: document.getElementById('micBtn'),
        leaveBtn: document.getElementById('leaveBtn'),
        settingsBtn: document.getElementById('settingsBtn'),
        settingsModal: document.getElementById('settingsModal'),
        closeSettingsBtn: document.getElementById('closeSettingsBtn')
    };

    document.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        loadUserFromStorage();
    });

    function setupEventListeners() {
        if (elements.joinBtn) elements.joinBtn.addEventListener('click', joinRoom);
        if (elements.micBtn) elements.micBtn.addEventListener('click', toggleMute);
        if (elements.leaveBtn) elements.leaveBtn.addEventListener('click', leaveRoom);
        if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', openSettings);
        if (elements.closeSettingsBtn) elements.closeSettingsBtn.addEventListener('click', closeSettings);
        if (elements.userName) elements.userName.addEventListener('keypress', (e) => {
            if (e.key === 'Enter') joinRoom();
        });
    }

    function loadUserFromStorage() {
        const savedName = localStorage.getItem('voicechat_username');
        if (savedName && elements.userName) elements.userName.value = savedName;
    }

    async function initAudioProcessing() {
        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: state.sampleRate,
                latencyHint: 'interactive'
            });
        }

        if (state.audioContext.state === 'suspended') {
            await state.audioContext.resume();
        }

        // Создаём цепочку обработки
        state.processingChain = [];

        // 1. Эквалайзер (3 полосы)
        const eq = createEqualizer();
        state.processingChain.push(...eq);

        // 2. Компрессор
        const compressor = createCompressor();
        state.processingChain.push(compressor);

        // 3. Noise Gate
        const noiseGate = createNoiseGate();
        state.processingChain.push(noiseGate);

        // 4. Эхоподавление
        const echoCanceller = createEchoCanceller();
        state.processingChain.push(echoCanceller);
    }

    function createEqualizer() {
        const filters = [];

        // High-pass filter для удаления низкочастотного шума
        const highpass = state.audioContext.createBiquadFilter();
        highpass.type = 'highpass';
        highpass.frequency.value = 100;
        highpass.Q.value = 0.7;
        filters.push(highpass);

        // Presence boost для чёткости речи
        const presence = state.audioContext.createBiquadFilter();
        presence.type = 'peaking';
        presence.frequency.value = 3000;
        presence.Q.value = 1.5;
        presence.gain.value = 4;
        filters.push(presence);

        // De-essing для уменьшения свистящих
        const deEsser = state.audioContext.createBiquadFilter();
        deEsser.type = 'notch';
        deEsser.frequency.value = 6000;
        deEsser.Q.value = 2;
        filters.push(deEsser);

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
        const noiseGate = state.audioContext.createScriptProcessor(512, 1, 1);
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
                // Мягкий gate (плавное затухание)
                const gain = Math.min(1, (rms - threshold) / threshold);
                for (let i = 0; i < input.length; i++) {
                    output[i] = input[i] * gain;
                }
            }
        };

        return noiseGate;
    }

    function createEchoCanceller() {
        const echoCanceller = state.audioContext.createDynamicsCompressor();
        echoCanceller.threshold.value = -30;
        echoCanceller.knee.value = 5;
        echoCanceller.ratio.value = 3;
        echoCanceller.attack.value = 0.0005;
        echoCanceller.release.value = 0.03;
        return echoCanceller;
    }

    async function startMicrophone() {
        await initAudioProcessing();

        state.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: state.sampleRate,
                latency: 0.005
            },
            video: false
        });

        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);

        // Подключаем цепочку обработки
        let currentNode = source;
        for (const processor of state.processingChain) {
            currentNode.connect(processor);
            currentNode = processor;
        }

        // Создаём анализатор для VAD
        const analyser = state.audioContext.createAnalyser();
        analyser.fftSize = 512;
        analyser.smoothingTimeConstant = 0.8;
        currentNode.connect(analyser);

        // Создаём процессор для отправки
        state.audioProcessor = state.audioContext.createScriptProcessor(state.bufferSize, 1, 1);

        state.audioProcessor.onaudioprocess = (event) => {
            if (!state.isJoined || state.isMuted) return;

            const audioData = event.inputBuffer.getChannelData(0);

            // VAD - проверяем уровень
            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            analyser.getByteTimeDomainData(dataArray);

            let sum = 0;
            for (let i = 0; i < dataArray.length; i++) {
                const value = (dataArray[i] - 128) / 128;
                sum += value * value;
            }
            const rms = Math.sqrt(sum / dataArray.length);

            if (rms < state.speakingThreshold) {
                // Отправляем маркер тишины (1 байт)
                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(new Uint8Array([0]));
                }
            } else {
                // Конвертируем в PCM 16-bit
                const pcmData = floatToPCM16Optimized(audioData);

                // Добавляем заголовок (1 байт - тип данных, 2 байта - длина)
                const header = new Uint8Array(3);
                header[0] = 1; // Тип: аудио
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
        // Оптимизированная конвертация с дизерингом
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            // Добавляем дизеринг для уменьшения шума квантования
            const dither = (Math.random() * 2 - 1) * 0.0001;
            const s = Math.max(-1, Math.min(1, float32Array[i] + dither));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    function playRemoteAudio(userId, data) {
        if (!state.audioContext) return;

        const dataArray = new Uint8Array(data);

        // Проверяем тип данных
        if (dataArray[0] === 0) {
            // Тишина
            state.speakingUsers.delete(userId);
            updateSpeakingIndicator(userId, false);
            return;
        }

        if (dataArray[0] === 1) {
            // Аудио данные
            const length = (dataArray[1] << 8) | dataArray[2];
            const pcmData = dataArray.slice(3, 3 + length);

            const int16Array = new Int16Array(pcmData.buffer);
            const float32Array = new Float32Array(int16Array.length);

            for (let i = 0; i < int16Array.length; i++) {
                float32Array[i] = int16Array[i] / 32768.0;
            }

            // Проверяем, говорит ли пользователь
            const rms = Math.sqrt(float32Array.reduce((sum, val) => sum + val * val, 0) / float32Array.length);
            if (rms > state.speakingThreshold) {
                state.speakingUsers.add(userId);
                updateSpeakingIndicator(userId, true);
            } else {
                state.speakingUsers.delete(userId);
                updateSpeakingIndicator(userId, false);
            }

            // Применяем индивидуальную громкость
            const volume = state.volumeLevels.get(userId) || 1.0;

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
        const userName = elements.userName.value.trim();
        if (!userName) {
            alert('Пожалуйста, введите имя');
            return;
        }

        localStorage.setItem('voicechat_username', userName);

        try {
            await startMicrophone();

            state.user = {
                id: 'user_' + Math.random().toString(36).substring(2, 11),
                name: userName,
                avatarColor: generateRandomColor()
            };

            await connectWebSocket();

            elements.connectionPanel.style.display = 'none';
            elements.participantsGrid.style.display = 'grid';
            addParticipantToUI(state.user, true);

            state.isJoined = true;
            console.log('Joined room as', userName);

        } catch (error) {
            console.error('Failed to join room:', error);
            alert('Не удалось подключиться к микрофону: ' + error.message);
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
                sendJSONMessage('join', {
                    userId: state.user.id,
                    userName: state.user.name,
                    avatarColor: state.user.avatarColor
                });
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
                if (state.isJoined && state.reconnectAttempts < state.maxReconnectAttempts) {
                    state.reconnectAttempts++;
                    setTimeout(() => connectWebSocket().catch(console.error), 2000);
                } else if (state.isJoined) {
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
                case 'error':
                    console.error('Server error:', message.payload.message);
                    break;
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    function handleRoomState(payload) {
        if (payload.users) {
            payload.users.forEach(user => {
                if (user.id !== state.user.id) {
                    addParticipantToUI(user, false);
                }
            });
        }
    }

    function handleUserJoined(payload) {
        if (payload.user && payload.user.id !== state.user.id) {
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

    function sendJSONMessage(type, payload) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(JSON.stringify({ type, payload }));
        }
    }

    function leaveRoom() {
        state.reconnectAttempts = 0;
        if (state.ws) { state.ws.close(); state.ws = null; }
        stopMicrophone();
        state.participants.clear();
        elements.connectionPanel.style.display = 'block';
        elements.participantsGrid.style.display = 'none';
        elements.participantsGrid.innerHTML = '';
        state.isJoined = false;
    }

    function toggleMute() {
        if (!state.microphoneStream) return;
        state.isMuted = !state.isMuted;
        sendJSONMessage('mute', { isMuted: state.isMuted });
        elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
    }

    function openSettings() {
        if (elements.settingsModal) elements.settingsModal.style.display = 'flex';
    }

    function closeSettings() {
        if (elements.settingsModal) elements.settingsModal.style.display = 'none';
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