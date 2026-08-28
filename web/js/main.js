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
    isMuted: false
};

// WebRTC configuration
const rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' }
    ]
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
                autoGainControl: true
            },
            video: false
        });
        
        state.localStream = stream;
        state.user = {
            id: generateUserId(),
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
            if (state.isJoined) {
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
                
            case 'sdp_answer':
                handleSDPAnswer(message.payload);
                break;
                
            case 'ice_candidate':
                handleICECandidate(message.payload);
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
    
    // Add existing users
    payload.users.forEach(user => {
        if (user.id !== state.user.id) {
            addParticipantToUI(user, false);
            createPeerConnectionForUser(user.id);
        }
    });
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
        participant.card.remove();
        state.participants.delete(payload.userId);
    }
}

async function handleSDPAnswer(payload) {
    console.log('SDP answer received');
    
    if (state.peerConnection) {
        await state.peerConnection.setRemoteDescription(payload.answer);
    }
}

async function handleICECandidate(payload) {
    console.log('ICE candidate received');
    
    if (state.peerConnection && payload.candidate) {
        await state.peerConnection.addIceCandidate(payload.candidate);
    }
}

async function createPeerConnectionForUser(userId) {
    console.log('Creating PeerConnection');
    
    // Create RTCPeerConnection
    state.peerConnection = new RTCPeerConnection(rtcConfig);
    
    // Add local stream
    state.localStream.getTracks().forEach(track => {
        state.peerConnection.addTrack(track, state.localStream);
    });
    
    // Handle incoming tracks
    state.peerConnection.ontrack = (event) => {
        console.log('Received remote track');
        const remoteStream = event.streams[0];
        
        // Create audio element for this stream
        createAudioElement(userId, remoteStream);
    };
    
    // Handle ICE candidates
    state.peerConnection.onicecandidate = (event) => {
        if (event.candidate) {
            sendWebSocketMessage('ice_candidate', {
                userId: state.user.id,
                candidate: event.candidate
            });
        }
    };
    
    // Create offer
    const offer = await state.peerConnection.createOffer();
    await state.peerConnection.setLocalDescription(offer);
    
    // Send offer to server
    sendWebSocketMessage('sdp_offer', {
        userId: state.user.id,
        offer: offer
    });
}

function createAudioElement(userId, stream) {
    console.log('Creating audio element for user:', userId);
    
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    
    const audioElement = document.createElement('audio');
    audioElement.autoplay = true;
    audioElement.srcObject = stream;
    audioElement.id = `audio-${userId}`;
    
    // Create volume control
    const gainNode = state.audioContext.createGain();
    const source = state.audioContext.createMediaStreamSource(stream);
    source.connect(gainNode);
    gainNode.connect(state.audioContext.destination);
    
    // Store audio elements
    const participant = state.participants.get(userId);
    if (participant) {
        participant.audioElement = audioElement;
        participant.gainNode = gainNode;
        participant.source = source;
    }
    
    document.body.appendChild(audioElement);
}

function sendWebSocketMessage(type, payload) {
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
            const participant = state.participants.get(user.id);
            if (participant && participant.gainNode) {
                participant.gainNode.gain.value = e.target.value / 100;
            }
        });
        card.appendChild(volumeControl);
    }
    
    elements.participantsGrid.appendChild(card);
    state.participants.set(user.id, { user, card, isSelf });
}

function generateUserId() {
    return 'user_' + Math.random().toString(36).substr(2, 9);
}

function generateRandomColor() {
    const colors = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b'];
    return colors[Math.floor(Math.random() * colors.length)];
}
