// sw.js — app-shell precache. Bump CACHE_NAME on every release (only reliable update signal on Pages).
var CACHE_NAME = "app00046-v6";

var SHELL = [
  "./",
  "index.html",
  "styles.css",
  "labels.js",
  "app.js",
  "api.js",
  "ics.js",
  "airports.js",
  "vendor/worldmap.js",
  "vendor/ical.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-512-maskable.png",
  "icons/apple-touch-icon-180.png",
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    // cache: "reload" bypasses the browser HTTP cache (GitHub Pages serves max-age=600) — otherwise a
    // new worker could precache the OLD files and it took several reloads before a release showed up
    caches.open(CACHE_NAME).then(function (c) {
      return c.addAll(SHELL.map(function (u) { return new Request(u, { cache: "reload" }); }));
    })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE_NAME) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener("message", function (e) {
  if (e.data === "skipWaiting") self.skipWaiting();
});

self.addEventListener("fetch", function (e) {
  var url = new URL(e.request.url);
  // same-origin GET → cache-first (app shell); anything else (Apps Script etc.) → network only
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (e.request.mode === "navigate") {
    // any navigation (with/without trailing slash, any query) falls back to the cached shell
    e.respondWith(
      caches.match(e.request, { ignoreSearch: true }).then(function (hit) {
        if (hit) return hit;
        return caches.match("index.html").then(function (idx) { return idx || fetch(e.request); });
      })
    );
    return;
  }
  e.respondWith(
    caches.match(e.request).then(function (hit) {
      return hit || fetch(e.request);
    })
  );
});
