// Проверяем, не загружен ли уже скрипт
if (window.voiceChatApp) {
    console.warn('VoiceChat app already loaded');
} else {
    window.voiceChatApp = true;

    // Глобальное состояние
    const state = {
        ws: null,
        user: null,
        participants: new Map(),
        isJoined: false,
        isMuted: false,
        audioContext: null,
        audioProcessor: null,
        microphoneStream: null,
        reconnectAttempts: 0,
        maxReconnectAttempts: 3
    };

    // DOM элементы
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

    // Инициализация
    document.addEventListener('DOMContentLoaded', () => {
        setupEventListeners();
        loadUserFromStorage();
    });

    function setupEventListeners() {
        if (elements.joinBtn) {
            elements.joinBtn.addEventListener('click', joinRoom);
        }
        if (elements.micBtn) {
            elements.micBtn.addEventListener('click', toggleMute);
        }
        if (elements.leaveBtn) {
            elements.leaveBtn.addEventListener('click', leaveRoom);
        }
        if (elements.settingsBtn) {
            elements.settingsBtn.addEventListener('click', openSettings);
        }
        if (elements.closeSettingsBtn) {
            elements.closeSettingsBtn.addEventListener('click', closeSettings);
        }
        if (elements.userName) {
            elements.userName.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    joinRoom();
                }
            });
        }
    }

    function loadUserFromStorage() {
        const savedName = localStorage.getItem('voicechat_username');
        if (savedName && elements.userName) {
            elements.userName.value = savedName;
        }
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

        state.microphoneStream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000
            },
            video: false
        });

        const source = state.audioContext.createMediaStreamSource(state.microphoneStream);
        state.audioProcessor = state.audioContext.createScriptProcessor(2048, 1, 1);

        state.audioProcessor.onaudioprocess = (event) => {
            if (state.isJoined && !state.isMuted) {
                const audioData = event.inputBuffer.getChannelData(0);
                const pcmData = floatToPCM16(audioData);

                if (state.ws && state.ws.readyState === WebSocket.OPEN) {
                    state.ws.send(pcmData);
                }
            }
        };

        source.connect(state.audioProcessor);
        state.audioProcessor.connect(state.audioContext.destination);
    }

    function floatToPCM16(float32Array) {
        const pcm16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const s = Math.max(-1, Math.min(1, float32Array[i]));
            pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return pcm16.buffer;
    }

    function playRemoteAudio(pcmData) {
        if (!state.audioContext) return;

        const int16Array = new Int16Array(pcmData);
        const float32Array = new Float32Array(int16Array.length);

        for (let i = 0; i < int16Array.length; i++) {
            float32Array[i] = int16Array[i] / 32768.0;
        }

        const audioBuffer = state.audioContext.createBuffer(1, float32Array.length, 48000);
        audioBuffer.getChannelData(0).set(float32Array);

        const source = state.audioContext.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(state.audioContext.destination);
        source.start();
    }

    function stopMicrophone() {
        if (state.audioProcessor) {
            state.audioProcessor.disconnect();
            state.audioProcessor = null;
        }

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
                    playRemoteAudio(event.data);
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
                    console.log(`Reconnecting... Attempt ${state.reconnectAttempts}`);
                    setTimeout(() => {
                        connectWebSocket().catch(console.error);
                    }, 2000);
                } else if (state.isJoined) {
                    leaveRoom();
                }
            };
        });
    }

    function handleJSONMessage(data) {
        try {
            const message = JSON.parse(data);
            console.log('Received message:', message.type);

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
                    alert('Ошибка: ' + message.payload.message);
                    break;

                default:
                    console.warn('Unknown message type:', message.type);
            }
        } catch (error) {
            console.error('Failed to parse message:', error);
        }
    }

    function handleRoomState(payload) {
        console.log('Room state:', payload);

        if (payload.users) {
            payload.users.forEach(user => {
                if (user.id !== state.user.id) {
                    addParticipantToUI(user, false);
                }
            });
        }
    }

    function handleUserJoined(payload) {
        console.log('User joined:', payload.user);

        if (payload.user && payload.user.id !== state.user.id) {
            addParticipantToUI(payload.user, false);
        }
    }

    function handleUserLeft(payload) {
        console.log('User left:', payload.userId);

        const participant = state.participants.get(payload.userId);
        if (participant) {
            participant.card.remove();
            state.participants.delete(payload.userId);
        }
    }

    function sendJSONMessage(type, payload) {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            const message = {
                type: type,
                payload: payload
            };
            state.ws.send(JSON.stringify(message));
        }
    }

    function leaveRoom() {
        console.log('Leaving room');

        state.reconnectAttempts = 0;

        if (state.ws) {
            state.ws.close();
            state.ws = null;
        }

        stopMicrophone();

        state.participants.clear();

        elements.connectionPanel.style.display = 'block';
        elements.participantsGrid.style.display = 'none';
        elements.participantsGrid.innerHTML = '';

        state.isJoined = false;
        console.log('Left room');
    }

    function toggleMute() {
        if (!state.microphoneStream) return;

        state.isMuted = !state.isMuted;

        sendJSONMessage('mute', {
            isMuted: state.isMuted
        });

        elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
        console.log(state.isMuted ? 'Muted' : 'Unmuted');
    }

    function openSettings() {
        if (elements.settingsModal) {
            elements.settingsModal.style.display = 'flex';
        }
    }

    function closeSettings() {
        if (elements.settingsModal) {
            elements.settingsModal.style.display = 'none';
        }
    }

    function addParticipantToUI(user, isSelf = false) {
        if (state.participants.has(user.id)) {
            return;
        }

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

        elements.participantsGrid.appendChild(card);
        state.participants.set(user.id, { user, card, isSelf });
    }

    function generateRandomColor() {
        const colors = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b'];
        return colors[Math.floor(Math.random() * colors.length)];
    }
}