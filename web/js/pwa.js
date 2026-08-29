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
                const registration = await navigator.serviceWorker.register('/sw.js');
                console.log('Service Worker registered');

                // Проверяем обновления
                registration.update();
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        }

        // Настраиваем Media Session API
        if ('mediaSession' in navigator) {
            this.setupMediaSession();
        }
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
    }

    async requestWakeLock() {
        try {
            if ('wakeLock' in navigator) {
                if (window.voiceChatApp && window.voiceChatApp.state && window.voiceChatApp.state.isJoined) {
                    this.wakeLock = await navigator.wakeLock.request('screen');
                    console.log('Wake Lock acquired');
                }
            }
        } catch (error) {
            console.log('Wake Lock not available:', error.message);
        }
    }
}

// Инициализация при загрузке
window.pwaManager = new PWAManager();
window.pwaManager.init();