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

const rtcConfig = {
    iceServers: [
        {
            urls: [
                'stun:stun.l.google.com:19302',
                'stun:stun1.l.google.com:19302'
            ]
        },
        {
            urls: [
                'turn:voice.repozis.ru:3478?transport=udp',
                'turn:voice.repozis.ru:3478?transport=tcp'
            ],
            username: 'voicechat',
            credential: 'voicechat123'
        }
    ],
    iceCandidatePoolSize: 10,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require',
    iceTransportPolicy: 'all'
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
    elements.joinBtn.addEventListener('click', joinRoom);
    elements.micBtn.addEventListener('click', toggleMute);
    elements.leaveBtn.addEventListener('click', leaveRoom);
    if (elements.settingsBtn) elements.settingsBtn.addEventListener('click', openSettings);
    if (elements.closeSettingsBtn) elements.closeSettingsBtn.addEventListener('click', closeSettings);

    elements.userName.addEventListener('keypress', (e) => {
        if (e.key === 'Enter') joinRoom();
    });
}

function loadUserFromStorage() {
    const savedName = localStorage.getItem('voicechat_username');
    if (savedName) elements.userName.value = savedName;
}

async function initAudioContext() {
    if (!state.audioContext) {
        state.audioContext = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (state.audioContext.state === 'suspended') {
        await state.audioContext.resume();
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
        alert('Не удалось подключиться к микрофону.');
    }
}

async function connectWebSocket() {
    return new Promise((resolve, reject) => {
        const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const wsUrl = `${protocol}//${window.location.host}/ws`;
        state.ws = new WebSocket(wsUrl);

        state.ws.onopen = () => {
            console.log('WebSocket connected');
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
                setTimeout(() => connectWebSocket().catch(console.error), 2000);
            } else if (state.isJoined) {
                leaveRoom();
            }
        };
    });
}

function handleWebSocketMessage(data) {
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
    createPeerConnection();
}

function handleUserJoined(payload) {
    if (payload.user && payload.user.id !== state.user.id) {
        addParticipantToUI(payload.user, false);
    }
}

function handleUserLeft(payload) {
    const participant = state.participants.get(payload.userId);
    if (participant) {
        const audio = document.getElementById(`audio-${payload.userId}`);
        if (audio) audio.remove();
        participant.card.remove();
        state.participants.delete(payload.userId);
    }
}

async function createPeerConnection() {
    console.log('Creating RTCPeerConnection');

    if (state.peerConnection) {
        state.peerConnection.close();
    }

    state.pendingCandidates = [];
    const pc = new RTCPeerConnection(rtcConfig);
    state.peerConnection = pc;

    if (state.localStream) {
        state.localStream.getTracks().forEach(track => {
            pc.addTrack(track, state.localStream);
        });
    }

    pc.ontrack = (event) => {
        console.log('Received remote track:', event.track.id);
        const stream = (event.streams && event.streams[0]) ? event.streams[0] : new MediaStream([event.track]);
        attachAudioStream(event.track.id, stream);
    };

    pc.onicecandidate = (event) => {
        if (event.candidate) {
            console.log('Generated local candidate:', event.candidate.candidate);
            sendWebSocketMessage('ice_candidate', {
                userId: state.user.id,
                candidate: {
                    candidate: event.candidate.candidate,
                    sdpMid: event.candidate.sdpMid,
                    sdpMLineIndex: event.candidate.sdpMLineIndex,
                    usernameFragment: event.candidate.usernameFragment
                }
            });
        }
    };

    pc.onconnectionstatechange = () => {
        console.log('PeerConnection state:', pc.connectionState);
        if (pc.connectionState === 'connected') {
            console.log('🎉 WebRTC connection established successfully!');
        }
    };

    try {
        const offer = await pc.createOffer({
            offerToReceiveAudio: true,
            offerToReceiveVideo: false
        });
        await pc.setLocalDescription(offer);
        console.log('Sending SDP offer immediately');

        sendWebSocketMessage('sdp_offer', {
            userId: state.user.id,
            offer: offer
        });
    } catch (error) {
        console.error('Failed to create offer:', error);
    }
}

async function handleSDPOffer(payload) {
    console.log('Received SDP offer for renegotiation');
    if (!state.peerConnection) return;

    try {
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.offer));
        flushPendingCandidates();

        const answer = await state.peerConnection.createAnswer();
        await state.peerConnection.setLocalDescription(answer);

        sendWebSocketMessage('sdp_answer', {
            userId: state.user.id,
            answer: answer
        });
    } catch (error) {
        console.error('Failed to handle SDP offer:', error);
    }
}

async function handleSDPAnswer(payload) {
    console.log('Received SDP answer from server');
    if (!state.peerConnection) return;

    try {
        await state.peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
        console.log('Remote SDP Answer set successfully');
        flushPendingCandidates();
    } catch (error) {
        console.error('Failed to set remote description:', error);
    }
}

async function handleICECandidate(payload) {
    if (!payload.candidate) return;

    if (!state.peerConnection || !state.peerConnection.remoteDescription) {
        state.pendingCandidates.push(payload.candidate);
        console.log('Queued ICE candidate from server');
        return;
    }

    try {
        await state.peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
        console.log('Added ICE candidate from server');
    } catch (error) {
        console.error('Failed to add remote ICE candidate:', error);
    }
}

async function flushPendingCandidates() {
    if (state.pendingCandidates.length > 0) {
        for (const candidate of state.pendingCandidates) {
            try {
                await state.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
                console.log('Flushed and added pending ICE candidate');
            } catch (e) {
                console.error('Failed to flush candidate:', e);
            }
        }
        state.pendingCandidates = [];
    }
}

function attachAudioStream(trackId, stream) {
    let audio = document.getElementById(`audio-${trackId}`);
    if (!audio) {
        audio = document.createElement('audio');
        audio.id = `audio-${trackId}`;
        audio.autoplay = true;
        audio.playsInline = true;
        document.body.appendChild(audio);
    }

    if (audio.srcObject !== stream) {
        audio.srcObject = stream;
    }

    audio.play().catch(e => {
        console.warn('Autoplay prevented, requires user interaction:', e);
    });
}

function sendWebSocketMessage(type, payload) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify({ type, payload }));
    }
}

function leaveRoom() {
    state.reconnectAttempts = 0;
    if (state.ws) { state.ws.close(); state.ws = null; }
    if (state.peerConnection) { state.peerConnection.close(); state.peerConnection = null; }
    if (state.localStream) {
        state.localStream.getTracks().forEach(t => t.stop());
        state.localStream = null;
    }

    elements.connectionPanel.style.display = 'block';
    elements.participantsGrid.style.display = 'none';
    elements.participantsGrid.innerHTML = '';
    state.participants.clear();
    state.isJoined = false;
}

function toggleMute() {
    if (!state.localStream) return;
    state.isMuted = !state.isMuted;
    state.localStream.getAudioTracks().forEach(t => { t.enabled = !state.isMuted; });
    elements.micBtn.textContent = state.isMuted ? '🔇' : '🎤';
}

function openSettings() { if (elements.settingsModal) elements.settingsModal.style.display = 'flex'; }
function closeSettings() { if (elements.settingsModal) elements.settingsModal.style.display = 'none'; }

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
    elements.participantsGrid.appendChild(card);
    state.participants.set(user.id, { user, card, isSelf });
}

function generateRandomColor() {
    const colors = ['#7c6cff', '#ff6b6b', '#51cf66', '#ffd43b', '#4dabf7', '#ff922b'];
    return colors[Math.floor(Math.random() * colors.length)];
}