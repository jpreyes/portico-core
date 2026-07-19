// ──────────────────────────────────────────────────────────────────────────────
// Service Worker de PORTICO — soporte offline (PWA)
//
// Estrategia: "network-first con respaldo en caché".
//   • En línea  → siempre intenta la red (evita servir módulos viejos durante el
//                 desarrollo) y guarda una copia en caché.
//   • Sin red   → sirve la última copia cacheada → la app funciona offline.
//
// Al subir la versión de la app, suba también CACHE_VERSION para forzar una
// limpieza completa de la caché antigua en la próxima visita en línea.
// ──────────────────────────────────────────────────────────────────────────────
const CACHE_VERSION = 'v6';
const CACHE = `portico-${CACHE_VERSION}`;

// Núcleo mínimo para que la app arranque aunque sea la primera vez sin red.
// El resto de módulos (Three.js, solver, ui, ejemplos) se cachean al vuelo
// en la primera visita en línea gracias a la estrategia network-first.
const SHELL = [
  './',
  './index.html',
  './manifest.webmanifest',
  './style.css?v=6',
  './ui-v2.css?v=6',
  './js/app.js?v=6',
  './lib/numeric.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // allSettled: si algún recurso falla, no aborta toda la instalación.
    await Promise.allSettled(SHELL.map((u) => cache.add(u)));
    self.skipWaiting();   // activar la nueva versión sin esperar a cerrar pestañas
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  // Solo GET del mismo origen (no interferir con otros esquemas / POST)
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  e.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      // Guardar copia en caché (clonar antes de devolver)
      const cache = await caches.open(CACHE);
      cache.put(req, fresh.clone());
      return fresh;
    } catch {
      // Sin red: servir desde caché
      const cached = await caches.match(req);
      if (cached) return cached;
      // Para navegaciones, devolver el index.html cacheado (app shell)
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      return new Response('Sin conexión y sin copia en caché.', {
        status: 503, statusText: 'Offline',
        headers: { 'Content-Type': 'text/plain; charset=UTF-8' },
      });
    }
  })());
});
