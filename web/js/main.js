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
        noiseFilter: null,
        compressor: null,
        analyser: null,
        reconnectAttempts: 0,
        maxReconnectAttempts: 3,
        volumeLevels: new Map(), // Громкость для каждого пользователя
        speakingThreshold: 0.01, // Порог для определения речи
        speakingUsers: new Set() // Пользователи, которые сейчас говорят
    };

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

    async function initAudioContext() {
        if (!state.audioContext) {
            state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: 48000,
                latencyHint: 'interactive'
            });
        }

        if (state.audioContext.state === 'suspended') {
            await state.audioContext.resume();
        }
    }

    async function startMicrophone() {
        await initAudioContext();

        // Захватываем микрофон с улучшенными настройками
        state.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000,
                latency: 0.01
            },
            video: false
        });

        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);

        // Создаём фильтр шумоподавления (высокочастотный фильтр для удаления низкочастотного шума)
        const highpassFilter = state.audioContext.createBiquadFilter();
        highpassFilter.type = 'highpass';
        highpassFilter.frequency.value = 80; // Убираем гул ниже 80 Гц

        // Создаём компрессор для AGC
        const compressor = state.audioContext.createDynamicsCompressor();
        compressor.threshold.value = -24;
        compressor.knee.value = 30;
        compressor.ratio.value = 12;
        compressor.attack.value = 0.003;
        compressor.release.value = 0.25;

        // Создаём анализатор для определения уровня громкости
        const analyser = state.audioContext.createAnalyser();
        analyser.fftSize = 256;

        // Создаём обработчик аудио
        state.audioProcessor = state.audioContext.createScriptProcessor(2048, 1, 1);

        state.audioProcessor.onaudioprocess = (event) => {
            if (state.isJoined && !state.isMuted) {
                const audioData = event.inputBuffer.getChannelData(0);

                // Проверяем уровень громкости для VAD
                const bufferLength = analyser.frequencyBinCount;
                const dataArray = new Uint8Array(bufferLength);
                analyser.getByteTimeDomainData(dataArray);

                let sum = 0;
                for (let i = 0; i < bufferLength; i++) {
                    const value = (dataArray[i] - 128) / 128;
                    sum += value * value;
                }
                const rms = Math.sqrt(sum / bufferLength);

                // VAD: если звук тише порога, отправляем тишину
                if (rms < state.speakingThreshold) {
                    // Отправляем пакет тишины (меньшего размера)
                    const silenceData = new Int16Array(256); // 256 сэмплов тишины
                    const pcmData = silenceData.buffer;

                    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                        state.ws.send(pcmData);
                    }
                } else {
                    // Отправляем звук
                    const pcmData = floatToPCM16(audioData);

                    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                        state.ws.send(pcmData);
                    }
                }
            }
        };

        // Подключаем цепочку: source → highpass → compressor → analyser → processor
        source.connect(highpassFilter);
        highpassFilter.connect(compressor);
        compressor.connect(analyser);
        analyser.connect(state.audioProcessor);
        state.audioProcessor.connect(state.audioContext.destination);

        // Сохраняем ссылки
        state.noiseFilter = highpassFilter;
        state.compressor = compressor;
        state.analyser = analyser;
    }

    function floatToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    function playRemoteAudio(userId, pcmData) {
        if (!state.audioContext) return;

        const int16Array = new Int16Array(pcmData);
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

        const audioBuffer = state.audioContext.createBuffer(1, float32Array.length, 48000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = state.audioContext.createBufferSource();
        source.buffer = audioBuffer;

        // Создаём gain node для контроля громкости
        const gainNode = state.audioContext.createGain();
        gainNode.gain.value = volume;

        source.connect(gainNode);
        gainNode.connect(state.audioContext.destination);
        source.start();
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
        if (state.noiseFilter) state.noiseFilter = null;
        if (state.compressor) state.compressor = null;
        if (state.analyser) state.analyser = null;

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
            await initAudioContext();
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
                    // Не знаем, от кого пришли данные, используем 'remote'
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

        // Добавляем регулятор громкости для других пользователей
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