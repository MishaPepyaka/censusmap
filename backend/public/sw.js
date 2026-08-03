const SHELL_CACHE = "cmp-shell-v14";
const SHELL_CACHE_PREFIX = "cmp-shell-";
const TILE_CACHE = "cmp-map-tiles-v1";
const TILE_CACHE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
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
  "/map-action-icons/google-maps.png",
  "/map-action-icons/apple-maps.png",
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

function isBufferedTile(pathname) {
  return pathname.startsWith("/tiles/");
}

async function cacheTileResponse(cache, request, response) {
  const headers = new Headers(response.headers);
  headers.set("x-censusmap-cached-at", new Date().toISOString());
  const body = await response.clone().blob();
  await cache.put(request, new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers
  }));
}

async function bufferedTileResponse(request) {
  const cache = await caches.open(TILE_CACHE);
  const cached = await cache.match(request);
  const cachedAt = cached?.headers.get("x-censusmap-cached-at");
  const age = cachedAt ? Date.now() - Date.parse(cachedAt) : Number.POSITIVE_INFINITY;
  if (cached && Number.isFinite(age) && age < TILE_CACHE_MAX_AGE_MS) return cached;
  try {
    const response = await fetch(request);
    if (response.ok) await cacheTileResponse(cache, request, response);
    return response;
  } catch (error) {
    if (cached) return cached;
    throw error;
  }
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

  if (isBufferedTile(url.pathname)) {
    event.respondWith(bufferedTileResponse(event.request));
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
