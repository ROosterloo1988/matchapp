const CACHE_NAME = 'matchapp-v1';
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

