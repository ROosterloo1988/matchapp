const CACHE_NAME = 'matchapp-v3';
const ASSETS_TO_CACHE = [
  '/',
  '/index.html',
  '/manifest.json'
];

// Installeer de Service Worker en bewaar de statische bestanden
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(ASSETS_TO_CACHE);
    })
  );
  self.skipWaiting();
});

// Zorg dat de nieuwste Service Worker direct actief wordt
self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Onderschep internetverzoeken van de app
self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);

  // 1. API Calls (Live dart data): Netwerk ALTIJD eerst!
  if (requestUrl.pathname.startsWith('/api/')) {
    event.respondWith(
      fetch(event.request).catch((err) => {
        // Als internet compleet wegvalt, probeer dan de laatste versie uit de cache (offline modus)
        return caches.match(event.request);
      })
    );
    return;
  }

  // 2. Statische bestanden (HTML, CSS): Cache ALTIJD eerst (voor snelle opstart)!
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      // Gebruik cache, OF haal op van netwerk als het nog niet in de cache zit
      return cachedResponse || fetch(event.request);
    })
  );
});

// --- NIEUW: PUSH MELDINGEN OPVANGEN ---
self.addEventListener('push', function(event) {
    if (event.data) {
        const data = event.data.json();
        const options = {
            body: data.body,
            icon: '/icon-192x192.png',
            badge: '/icon-192x192.png',
            vibrate: [100, 50, 100],
            data: { url: '/' } // Waar gaan we heen als je erop klikt?
        };

        event.waitUntil(
            self.registration.showNotification(data.title, options)
        );
    }
});

self.addEventListener('notificationclick', function(event) {
    event.notification.close();
    event.waitUntil(
        clients.openWindow(event.notification.data.url)
    );
});
