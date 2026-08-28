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
    
    // Enter key in name input
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
    
    // Save username
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
        
        // TODO: Connect to WebSocket and setup WebRTC
        
        // Update UI
        elements.connectionPanel.style.display = 'none';
        elements.participantsGrid.style.display = 'grid';
        
        // Add self to participants
        addParticipantToUI(state.user, true);
        
        state.isJoined = true;
        console.log('Joined room as', userName);
        
    } catch (error) {
        console.error('Failed to join room:', error);
        alert('Не удалось получить доступ к микрофону. Проверьте разрешения браузера.');
    }
}

function leaveRoom() {
    // TODO: Close WebSocket and WebRTC connections
    state.isJoined = false;
    
    // Stop all tracks
    if (state.localStream) {
        state.localStream.getTracks().forEach(track => track.stop());
        state.localStream = null;
    }
    
    // Update UI
    elements.connectionPanel.style.display = 'block';
    elements.participantsGrid.style.display = 'none';
    elements.participantsGrid.innerHTML = '';
    
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
            // TODO: Apply volume
            console.log('Volume for', user.id, ':', e.target.value);
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
