// Глобальное состояние
const state = {
    ws: null,
    peerConnection: null,
    localStream: null,
    room: null,
    user: null,
    participants: new Map(),
    audioContext: null,
    isJoined: false,
    isMuted: false,
    reconnectAttempts: 0,
    maxReconnectAttempts: 3,
    pendingCandidates: []
};

// WebRTC configuration
const rtcConfig = {
    iceServers: [
        { 
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ] 
        }
    ],
    iceCandidatePoolSize: 10,
    iceTransportPolicy: 'all'
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
    elements.joinBtn.addEventListener('click', joinRoom);
    elements.micBtn.addEventListener('click', toggleMute);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    elements.settingsBtn.addEventListener('click', openSettings);
    elements.closeSettingsBtn.addEventListener('click', closeSettings);
    
    elements.userName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') {
            joinRoom();
        }
    });
}

function loadUserFromStorage() {
    const savedName = localStorage.getItem('voicechat_username');
    if (savedName) {
        elements.userName.value = savedName;
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
        // Request microphone access
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: true,
                autoGainControl: true,
                channelCount: 1,
                sampleRate: 48000
            },
            video: false
        });
        
        state.localStream = stream;
        state.user = {
            id: 'user_' + Math.random().toString(36).substr(2, 9),
            name: userName,
            avatarColor: generateRandomColor()
        };
        
        // Connect WebSocket
        await connectWebSocket();
        
        // Update UI
        elements.connectionPanel.style.display = 'none';
        elements.participantsGrid.style.display = 'grid';
        
        // Add self to participants
        addParticipantToUI(state.user, true);
        
        state.isJoined = true;
        console.log('Joined room as', userName);
        
    } catch (error) {
        console.error('Failed to join room:', error);
        alert('Не удалось подключиться. Проверьте доступ к микрофону и интернет-соединение.');
    }
}

async function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const wsUrl = `wss://${window.location.host}/ws`;
        state.ws = new WebSocket(wsUrl);
        
        state.ws.onopen = () => {
            console.log('WebSocket connected');
            
            // Join room
            sendWebSocketMessage('join', {
                userId: state.user.id,
                userName: state.user.name,
                avatarColor: state.user.avatarColor
            });
            
            resolve();
        };
        
        state.ws.onmessage = (event) => {
            handleWebSocketMessage(event.data);
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

function handleWebSocketMessage(data) {
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
                
            case 'sdp_offer':
                handleSDPOffer(message.payload);
                break;
                
            case 'sdp_answer':
                handleSDPAnswer(message.payload);
                break;
                
            case 'ice_candidate':
                handleICECandidate(message.payload);
                break;
                
            case 'error':
                console.error('Server error:', message.payload.message);
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
    
    // Добавляем существующих пользователей
    payload.users.forEach(user => {
        if (user.id !== state.user.id) {
            addParticipantToUI(user, false);
        }
    });
    
    // Создаём PeerConnection после получения состояния комнаты
    createPeerConnection();
}

function handleUserJoined(payload) {
    console.log('User joined:', payload.user);
    
    if (payload.user.id !== state.user.id) {
        addParticipantToUI(payload.user, false);
    }
}

function handleUserLeft(payload) {
    console.log('User left:', payload.userId);
    
    const participant = state.participants.get(payload.userId);
    if (participant) {
        if (participant.audioElement) {
            participant.audioElement.remove();
        }
        if (participant.gainNode) {
            participant.gainNode.disconnect();
        }
        if (participant.source) {
            participant.source.disconnect();
        }
        participant.card.remove();
        state.participants.delete(payload.userId);
    }
}

async function handleSDPOffer(payload) {
    console.log('Received SDP offer for renegotiation');
    
    if (!state.peerConnection) {
        console.warn('No PeerConnection available for SDP offer');
        return;
    }
    
    try {
        await state.peerConnection.setRemoteDescription(payload.offer);
        console.log('Remote description set for renegotiation');
        
        // Создаём answer
        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);
        console.log('Sending SDP answer for renegotiation');
        
        sendWebSocketMessage('sdp_answer', {
            userId: state.user.id,
            answer: answer
        });
    } catch (error) {
        console.error('Failed to handle SDP offer:', error);
    }
}

async function handleSDPAnswer(payload) {
    console.log('SDP answer received');
    
    if (!state.peerConnection) {
        console.warn('No PeerConnection available for SDP answer');
        return;
    }
    
    try {
        await state.peerConnection.setRemoteDescription(payload.answer);
        console.log('Remote description set successfully');
        
        // Добавляем отложенные ICE кандидаты
        if (state.pendingCandidates.length > 0) {
            console.log('Adding pending ICE candidates:', state.pendingCandidates.length);
            for (const candidate of state.pendingCandidates) {
                await state.peerConnection.addIceCandidate(candidate);
            }
            state.pendingCandidates = [];
        }
    } catch (error) {
        console.error('Failed to set remote description:', error);
    }
}

async function handleICECandidate(payload) {
    console.log('ICE candidate received:', payload.candidate);
    
    if (!state.peerConnection) {
        console.warn('No PeerConnection available for ICE candidate');
        return;
    }
    
    if (payload.candidate) {
        try {
            // Если remote description ещё не установлен, сохраняем кандидата
            if (!state.peerConnection.remoteDescription) {
                console.log('Remote description not set yet, saving candidate');
                state.pendingCandidates.push(payload.candidate);
                return;
            }
            
            await state.peerConnection.addIceCandidate(payload.candidate);
            console.log('ICE candidate added successfully');
        } catch (error) {
            console.error('Failed to add ICE candidate:', error);
        }
    }
}

async function createPeerConnection() {
    console.log('Creating PeerConnection');
    
    // Закрываем старое соединение если есть
    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }
    
    // Очищаем отложенные кандидаты
    state.pendingCandidates = [];
    
    // Создаём новое RTCPeerConnection
    const peerConnection = new RTCPeerConnection(rtcConfig);
    state.peerConnection = peerConnection;
    
    // Добавляем локальный поток
    state.localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, state.localStream);
        console.log('Added local track:', track.kind);
    });
    
    // Обработка входящих треков
    peerConnection.ontrack = (event) => {
        console.log('Received remote track:', event.track.kind);
        console.log('Streams:', event.streams);
        
        if (event.track.kind === 'audio') {
            const remoteStream = event.streams[0];
            if (remoteStream) {
                createAudioElement(event.track, remoteStream);
            }
        }
    };
    
    // Обработка ICE кандидатов
    peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Sending ICE candidate:', event.candidate.candidate);
            sendWebSocketMessage('ice_candidate', {
                userId: state.user.id,
                candidate: event.candidate
            });
        } else {
            console.log('ICE gathering completed');
        }
    };
    
    // Логирование состояния соединения
    peerConnection.onconnectionstatechange = () => {
        console.log('Connection state:', peerConnection.connectionState);
        if (peerConnection.connectionState === 'connected') {
            console.log('WebRTC connection established!');
        }
    };
    
    // Логирование состояния ICE
    peerConnection.oniceconnectionstatechange = () => {
        console.log('ICE connection state:', peerConnection.iceConnectionState);
        if (peerConnection.iceConnectionState === 'connected') {
            console.log('ICE connection established!');
        }
    };
    
    // Логирование состояния ICE gathering
    peerConnection.onicegatheringstatechange = () => {
        console.log('ICE gathering state:', peerConnection.iceGatheringState);
    };
    
    // Логирование signaling state
    peerConnection.onsignalingstatechange = () => {
        console.log('Signaling state:', peerConnection.signalingState);
    };
    
    // Создаём offer
    try {
        const offer = await peerConnection.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        await peerConnection.setLocalDescription(offer);
        console.log('Sending SDP offer');
        
        sendWebSocketMessage('sdp_offer', {
            userId: state.user.id,
            offer: offer
        });
    } catch (error) {
        console.error('Failed to create offer:', error);
    }
}

function createAudioElement(track, stream) {
    console.log('Creating audio element for track:', track.id);
    
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    const audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    audioElement.srcObject = stream;
    
    // Создаём усиление для контроля громкости
    const gainNode = state.audioContext.createGain();
    const source = state.audioContext.createMediaStreamSource(stream);
    source.connect(gainNode);
    gainNode.connect(state.audioContext.destination);
    
    // Сохраняем ссылки
    const audioId = `audio-${Date.now()}`;
    audioElement.id = audioId;
    
    document.body.appendChild(audioElement);
    
    console.log('Audio element created:', audioId);
}

function sendWebSocketMessage(type, payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        const message = {
            type: type,
            payload: payload
        };
        state.ws.send(JSON.stringify(message));
    } else {
        console.warn('WebSocket is not connected');
    }
}

function leaveRoom() {
    console.log('Leaving room');
    
    state.reconnectAttempts = 0;
    
    // Close WebSocket
    if (state.ws) {
        state.ws.close();
        state.ws = null;
    }
    
    // Close PeerConnection
    if (state.peerConnection) {
        state.peerConnection.close();
        state.peerConnection = null;
    }
    
    // Stop all tracks
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    
    // Clean up audio elements
    state.participants.forEach((participant, userId) => {
        if (participant.audioElement) {
            participant.audioElement.remove();
        }
        if (participant.gainNode) {
            participant.gainNode.disconnect();
        }
        if (participant.source) {
            participant.source.disconnect();
        }
    });
    
    // Clear participants
    state.participants.clear();
    
    // Update UI
    elements.connectionPanel.style.display = 'block';
    elements.participantsGrid.style.display = 'none';
    elements.participantsGrid.innerHTML = '';
    
    state.isJoined = false;
    console.log('Left room');
}

function toggleMute() {
    if (!state.localStream) return;
    
    state.isMuted = !state.isMuted;
    state.localStream.getAudioTracks().forEach(track => {
        track.enabled = !state.isMuted;
    });
    
    elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
    console.log(state.isMuted ? 'Muted' : 'Unmuted');
}

function openSettings() {
    elements.settingsModal.style.display = 'flex';
}

function closeSettings() {
    elements.settingsModal.style.display = 'none';
}

function addParticipantToUI(user, isSelf = false) {
    const card = document.createElement('div');
    card.className = 'participant-card glass';
    card.id = `participant-${user.id}`;
    
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = user.avatarColor;
    avatar.textContent = user.name.charAt(0).toUpperCase();
    
    const name = document.createElement('div');
    name.className = 'participant-name';
    name.textContent = isSelf ? `${user.name} (Вы)` : user.name;
    
    card.appendChild(avatar);
    card.appendChild(name);
    
    // Volume control (не для себя)
    if (!isSelf) {
        const volumeControl = document.createElement('input');
        volumeControl.type = 'range';
        volumeControl.min = '0';
        volumeControl.max = '200';
        volumeControl.value = '100';
        volumeControl.className = 'volume-control';
        volumeControl.addEventListener('input', (e) => {
            // TODO: Применить громкость к конкретному потоку
            console.log('Volume for', user.id, ':', e.target.value);
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
