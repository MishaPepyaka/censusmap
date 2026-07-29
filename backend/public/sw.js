const SHELL_CACHE = "cmp-shell-v5";
const SHELL_CACHE_PREFIX = "cmp-shell-";
const APP_SHELL = [
  "/landing.html",
  "/index.html",
  "/edit.html",
  "/edit-geometry.html",
  "/styles.css",
  "/app-auth.js",
  "/offline-data.js",
  "/app-landing.js",
  "/app.js",
  "/app-edit.js",
  "/app-edit-geometry.js",
  "/vendor/leaflet/leaflet.css",
  "/vendor/leaflet/leaflet.js",
  "/person-marker.svg",
  "/place-icons/band_hall.svg",
  "/place-icons/band_office.svg",
  "/place-icons/church.svg",
  "/place-icons/cultural.svg",
  "/place-icons/gas_station.svg",
  "/place-icons/health_office.svg",
  "/place-icons/local_cafe.svg",
  "/place-icons/other.svg",
  "/place-icons/radio_tower.svg",
  "/place-icons/school.svg",
  "/place-icons/stadium.svg"
];

function offlineShellForPath(pathname) {
  if (/^\/\d+\/edit(?:\/)?$/.test(pathname)) return "/edit.html";
  if (/^\/\d+\/edit_geometry(?:\/)?$/.test(pathname)) return "/edit-geometry.html";
  if (/^\/\d+(?:\/)?$/.test(pathname)) return "/index.html";
  if (pathname === "/") return "/landing.html";
  return null;
}

function isCacheableStaticAsset(pathname) {
  return pathname.startsWith("/vendor/")
    || pathname.startsWith("/place-icons/")
    || /\.(?:css|js|svg|png|webp|woff2?)$/.test(pathname);
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(APP_SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => (key.startsWith(SHELL_CACHE_PREFIX) && key !== SHELL_CACHE) || key === "cmp-editor-static-v1")
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (event.request.mode === "navigate") {
    const fallback = offlineShellForPath(url.pathname);
    if (!fallback) return;
    event.respondWith(
      fetch(event.request).catch(() => caches.match(fallback))
    );
    return;
  }

  if (!isCacheableStaticAsset(url.pathname)) return;
  event.respondWith(
    caches.match(event.request, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          void caches.open(SHELL_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return response;
      });
    })
  );
});
