const CACHE_NAME = "sam-piegeage-v2-20260918-3";
const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=20260918-3",
  "./app.js?v=20260918-3",
  "./config.js?v=20260918-3",
  "./site.webmanifest",
  "./favicon.ico",
  "./favicon-16x16.png",
  "./favicon-32x32.png",
  "./apple-touch-icon.png",
  "./android-chrome-192x192.png",
  "./android-chrome-512x512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./logo-sudexpe.png",
  "./logo-sam-piegeage.png",
  "./bouton-connexion.png",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
  "https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js",
  "https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(caches.open(CACHE_NAME).then(cache => Promise.allSettled(CORE_ASSETS.map(asset => cache.add(asset)))));
});

self.addEventListener("activate", event => {
  event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);

  if (url.hostname === "cdn.jsdelivr.net") {
    event.respondWith(caches.match(request).then(cached => cached || fetch(request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
      return response;
    })));
    return;
  }

  if (url.origin !== self.location.origin) return;

  event.respondWith(fetch(request).then(response => {
    if (response.ok) {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
    }
    return response;
  }).catch(() => caches.match(request).then(cached => cached || (request.mode === "navigate" ? caches.match("./index.html") : Response.error()))));
});
