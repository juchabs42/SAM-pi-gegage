const CACHE_NAME = "sam-piegeage-v20260819-2";

const CORE_ASSETS = [
  "./",
  "./index.html",
  "./style.css?v=20260819-2",
  "./app.js?v=20260819-2",
  "./config.js?v=20260819-2",
  "./site.webmanifest",
  "./favicon.ico",
  "./favicon.png",
  "./apple-touch-icon.png",
  "./android-chrome-192x192.png",
  "./android-chrome-512x512.png",
  "./icon-192-maskable.png",
  "./icon-512-maskable.png",
  "./logo-sudexpe.png",
  "./favicon-32x32.png",
  "./favicon-16x16.png",
  "./bouton-connexion.png",
  "./logo-sam-piegeage.png"
];

self.addEventListener("install", event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      Promise.allSettled(CORE_ASSETS.map(asset => cache.add(asset)))
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", event => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Network-first avoids keeping an obsolete GitHub Pages version.
  event.respondWith(
    fetch(request)
      .then(response => {
        if (response && response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(request, clone));
        }
        return response;
      })
      .catch(() =>
        caches.match(request).then(cached =>
          cached || (request.mode === "navigate" ? caches.match("./index.html") : Response.error())
        )
      )
  );
});
