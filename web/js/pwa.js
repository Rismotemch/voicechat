/**
 * VoiceChat PWA & Device Lifecycle Manager
 * File: web/js/pwa.js
 * 
 * Handles Service Worker registration, Screen Wake Lock API
 * and Media Session API lock screen controls.
 */

class PWAManager {
    constructor() {
        /** @type {WakeLockSentinel|null} */
        this.wakeLock = null;
        this.isInCall = false;
        this.currentRoomName = 'main';
        this.isMuted = false;

        this._bindVisibilityHandler();
    }

    /**
     * Инициализация Service Worker и Media Session
     */
    async init() {
        if ('serviceWorker' in navigator) {
            try {
                const registration = await navigator.serviceWorker.register('/sw.js', {
                    scope: '/'
                });
                console.log('[PWA] Service Worker registered with scope:', registration.scope);

                // Периодическая проверка обновлений воркера
                registration.update();
            } catch (error) {
                console.warn('[PWA] Service Worker registration failed:', error.message);
            }
        }

        this.setupMediaSession('Главная');
    }

    /**
     * Настройка карточки медиа-сессии (шторка уведомлений и экран блокировки)
     * @param {string} roomName 
     */
    setupMediaSession(roomName = 'main') {
        this.currentRoomName = roomName;

        if (!('mediaSession' in navigator)) return;

        navigator.mediaSession.metadata = new MediaMetadata({
            title: 'VoiceChat',
            artist: `Комната: ${roomName}`,
            album: 'Голосовой чат',
            artwork: [
                { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
                { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' }
            ]
        });

        // Регистрация системных действий для экрана блокировки / гарнитур
        try {
            navigator.mediaSession.setActionHandler('togglemicrophone', () => {
                const micBtn = document.getElementById('micBtn');
                if (micBtn) micBtn.click();
            });
        } catch (e) {}

        try {
            navigator.mediaSession.setActionHandler('hangup', () => {
                const leaveBtn = document.getElementById('leaveBtn');
                if (leaveBtn) leaveBtn.click();
            });
        } catch (e) {}
    }

    /**
     * Активация удержания экрана во время голосового вызова
     */
    async acquireWakeLock() {
        this.isInCall = true;

        if (!('wakeLock' in navigator)) return;

        try {
            if (!this.wakeLock || this.wakeLock.released) {
                this.wakeLock = await navigator.wakeLock.request('screen');
                this.wakeLock.addEventListener('release', () => {
                    this.wakeLock = null;
                });
                console.log('[PWA] Screen Wake Lock acquired');
            }
        } catch (error) {
            console.warn('[PWA] Failed to acquire Screen Wake Lock:', error.message);
        }
    }

    /**
     * Освобождение экрана при выходе из комнаты
     */
    async releaseWakeLock() {
        this.isInCall = false;

        if (this.wakeLock) {
            try {
                await this.wakeLock.release();
                this.wakeLock = null;
                console.log('[PWA] Screen Wake Lock released');
            } catch (error) {
                console.warn('[PWA] Error releasing Wake Lock:', error.message);
            }
        }
    }

    /**
     * Автоматический повторный захват Wake Lock при возвращении во вкладку
     * @private
     */
    _bindVisibilityHandler() {
        document.addEventListener('visibilitychange', async () => {
            if (this.isInCall && document.visibilityState === 'visible') {
                await this.acquireWakeLock();
            }
        });
    }
}

// Глобальный синглтон PWA-менеджера
window.pwaManager = new PWAManager();
window.pwaManager.init();