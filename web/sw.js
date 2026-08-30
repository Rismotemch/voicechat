/**
 * VoiceChat Service Worker
 * File: web/sw.js
 * 
 * Provides offline shell caching, instant updates, and asset management.
 */

const CACHE_NAME = 'voicechat-v4.3.6';

// Полный реестр статических ассетов приложения
const PRECACHE_ASSETS = [
    '/',
    '/index.html',
    '/css/style.css',
    '/js/audio-processor.js',
    '/js/audio.js',
    '/js/main.js',
    '/js/pwa.js',
    '/manifest.json',
    '/icons/icon-192.png',
    '/icons/icon-512.png'
];

// =============================================================================
// Lifecycle Events
// =============================================================================

// Установка: предварительное кэширование базовых ресурсов
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then((cache) => {
                return cache.addAll(PRECACHE_ASSETS);
            })
            .then(() => {
                // Немедленная активация без ожидания закрытия вкладок
                return self.skipWaiting();
            })
            .catch((err) => {
                console.warn('[SW] Pre-cache failed:', err);
            })
    );
});

// Активация: удаление устаревших версий кэша и захват управления клиентами
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((cacheNames) => {
                return Promise.all(
                    cacheNames.map((cacheName) => {
                        if (cacheName !== CACHE_NAME) {
                            return caches.delete(cacheName);
                        }
                    })
                );
            })
            .then(() => {
                return self.clients.claim();
            })
    );
});

// =============================================================================
// Fetch Strategy: Network-First для JS/HTML, Cache-First для медиа и стилей
// =============================================================================

self.addEventListener('fetch', (event) => {
    const request = event.request;

    // Игнорируем не-GET запросы и протоколы отличные от HTTP(S) (например, ws://, chrome-extension://)
    if (request.method !== 'GET' || !request.url.startsWith('http')) {
        return;
    }

    const url = new URL(request.url);

    // Пропускаем мимо кэша динамические эндпоинты сервера
    if (url.pathname.startsWith('/ws') || url.pathname.startsWith('/health') || url.pathname.startsWith('/uploads')) {
        return;
    }

    // 1. Для навигации (HTML) и JS скриптов: Network-First с быстрым таймаутом
    // Это гарантирует, что пользователи всегда получают свежий код обработки звука
    if (request.mode === 'navigate' || url.pathname.endsWith('.js') || url.pathname === '/') {
        event.respondWith(
            fetch(request)
                .then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        const responseClone = networkResponse.clone();
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, responseClone);
                        });
                    }
                    return networkResponse;
                })
                .catch(() => {
                    return caches.match(request).then((cachedResponse) => {
                        if (cachedResponse) return cachedResponse;
                        if (request.mode === 'navigate') {
                            return caches.match('/');
                        }
                        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
                    });
                })
        );
        return;
    }

    // 2. Для статичных ресурсов (CSS, иконки, манифест): Cache-First с фоновым обновлением
    event.respondWith(
        caches.match(request).then((cachedResponse) => {
            if (cachedResponse) {
                // Фоновое обновление кэша (Stale-While-Revalidate)
                fetch(request).then((networkResponse) => {
                    if (networkResponse && networkResponse.status === 200) {
                        caches.open(CACHE_NAME).then((cache) => {
                            cache.put(request, networkResponse);
                        });
                    }
                }).catch(() => { });
                return cachedResponse;
            }

            return fetch(request).then((networkResponse) => {
                if (networkResponse && networkResponse.status === 200) {
                    const responseClone = networkResponse.clone();
                    caches.open(CACHE_NAME).then((cache) => {
                        cache.put(request, responseClone);
                    });
                }
                return networkResponse;
            });
        })
    );
});

// Обработка сообщений от основного потока
self.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});