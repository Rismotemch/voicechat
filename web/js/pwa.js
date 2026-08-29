// PWA functionality
class PWAManager {
    constructor() {
        this.wakeLock = null;
        this.mediaSession = null;
        this.isActive = false;
    }

    async init() {
        // Регистрируем Service Worker
        if ('serviceWorker' in navigator) {
            try {
                await navigator.serviceWorker.register('/sw.js');
                console.log('Service Worker registered');
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        }

        // Настраиваем Media Session API
        if ('mediaSession' in navigator) {
            this.setupMediaSession();
        }

        // Запрашиваем Wake Lock при активации
        this.setupWakeLock();
    }

    setupMediaSession() {
        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'Voice Chat',
            artist: 'Комната: ' + (window.currentRoom || 'main'),
            album: 'Voice Chat',
            artwork: [
                { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
            ]
        });

        // Обработчики для управления с экрана блокировки
        navigator.mediaSession.setActionHandler('play', () => {
            console.log('Play');
            this.resumeAudio();
        });

        navigator.mediaSession.setActionHandler('pause', () => {
            console.log('Pause');
            this.suspendAudio();
        });

        navigator.mediaSession.setActionHandler('stop', () => {
            console.log('Stop');
            if (window.voiceChatApp && window.voiceChatApp.leaveRoom) {
                window.voiceChatApp.leaveRoom();
            }
        });
    }

    setupWakeLock() {
        document.addEventListener('visibilitychange', async () => {
            if (document.visibilityState === 'visible') {
                await this.requestWakeLock();
            }
        });

        // Запрашиваем при инициализации
        this.requestWakeLock();
    }

    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                console.log('Wake Lock acquired');

                // Обработчик освобождения
                this.wakeLock.addEventListener('release', () => {
                    console.log('Wake Lock released');
                });
            }
        } catch (error) {
            console.error('Failed to acquire Wake Lock:', error);
        }
    }

    resumeAudio() {
        if (window.voiceChatApp && window.voiceChatApp.state) {
            const state = window.voiceChatApp.state;
            if (state.audioContext && state.audioContext.state === 'suspended') {
                state.audioContext.resume();
            }
            if (state.microphoneStream) {
                state.microphoneStream.getTracks().forEach(track => {
                    track.enabled = true;
                });
            }
        }
    }

    suspendAudio() {
        if (window.voiceChatApp && window.voiceChatApp.state) {
            const state = window.voiceChatApp.state;
            if (state.audioContext) {
                state.audioContext.suspend();
            }
            if (state.microphoneStream) {
                state.microphoneStream.getTracks().forEach(track => {
                    track.enabled = false;
                });
            }
        }
    }
}

// Инициализация при загрузке
window.pwaManager = new PWAManager();
window.pwaManager.init();