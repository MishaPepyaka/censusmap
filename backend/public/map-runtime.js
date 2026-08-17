(function initMapRuntime() {
  const TILE_CACHE = "cmp-map-tiles-v1";

  function readMapUrlState() {
    const params = new URLSearchParams(window.location.search);
    const zoomValue = params.get("zoom");
    const latValue = params.get("lat");
    const lngValue = params.get("lng");
    const zoom = zoomValue === null ? null : Number(zoomValue);
    const lat = latValue === null ? null : Number(latValue);
    const lng = lngValue === null ? null : Number(lngValue);
    return {
      zoom,
      lat,
      lng,
      hasCenter: Number.isFinite(lat) && Number.isFinite(lng)
        && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180
    };
  }

  function bindMapUrlState(map, requested, onQueryChange) {
    function sync() {
      const center = map.getCenter();
      const params = new URLSearchParams(window.location.search);
      params.set("zoom", String(Math.round(map.getZoom())));
      params.set("lat", center.lat.toFixed(6));
      params.set("lng", center.lng.toFixed(6));
      const query = params.toString();
      window.history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
      onQueryChange?.(query);
    }

    function applyRequestedMapView() {
      if (requested.hasCenter) {
        const zoom = Number.isFinite(requested.zoom) ? Math.max(0, Math.min(22, requested.zoom)) : map.getZoom();
        map.setView([requested.lat, requested.lng], zoom);
      } else if (Number.isFinite(requested.zoom)) {
        map.setZoom(Math.max(0, Math.min(22, requested.zoom)));
      }
      sync();
    }

    map.on("zoomend moveend", sync);
    return { sync, applyRequestedMapView };
  }

  function setupBaseMap(map, button) {
    const satelliteLayer = L.tileLayer("/tiles/satellite/{z}/{y}/{x}", {
      maxZoom: 22,
      maxNativeZoom: 17,
      attribution: "Tiles &copy; Esri"
    });
    const schematicLayer = L.tileLayer("/tiles/schematic/{z}/{y}/{x}", {
      maxZoom: 19,
      attribution: "&copy; OpenStreetMap contributors"
    });
    const stadiaBrightLayer = L.tileLayer("https://tiles.stadiamaps.com/tiles/osm_bright/{z}/{x}/{y}{r}.png", {
      maxZoom: 22,
      maxNativeZoom: 20,
      attribution: '&copy; <a href="https://stadiamaps.com/" target="_blank" rel="noreferrer">Stadia Maps</a> &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noreferrer">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>'
    });
    let currentMode = "satellite";
    satelliteLayer.addTo(map);

    function updateButton() {
      const modeLabel = currentMode === "satellite"
        ? "Satellite"
        : (currentMode === "schematic" ? "Schematic" : "Stadia OSM Bright");
      button?.setAttribute("title", `Switch base map (current: ${modeLabel})`);
      button?.setAttribute("aria-label", `Switch base map (current: ${modeLabel})`);
    }

    function setMode(mode) {
      if (mode === currentMode) return;
      map.removeLayer(satelliteLayer);
      map.removeLayer(schematicLayer);
      map.removeLayer(stadiaBrightLayer);
      if (mode === "satellite") map.addLayer(satelliteLayer);
      else if (mode === "schematic") map.addLayer(schematicLayer);
      else map.addLayer(stadiaBrightLayer);
      currentMode = mode;
      updateButton();
    }

    if (button) {
      button.textContent = "🗺️";
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        setMode(currentMode === "satellite" ? "schematic" : (currentMode === "schematic" ? "stadia_bright" : "satellite"));
      });
    }
    updateButton();
    return { satelliteLayer, schematicLayer, stadiaBrightLayer, setMode };
  }

  function setupTileCacheStatus(statusElement, layers) {
    if (!statusElement) return;
    let refreshTimer = null;
    async function refresh() {
      if (!("caches" in window)) {
        statusElement.textContent = "Tiles: unavailable";
        return;
      }
      try {
        const cache = await caches.open(TILE_CACHE);
        const requests = await cache.keys();
        let bytes = 0;
        for (const request of requests) {
          const response = await cache.match(request);
          if (!response) continue;
          const length = Number(response.headers.get("x-censusmap-size") || response.headers.get("content-length"));
          bytes += Number.isFinite(length) && length >= 0 ? length : (await response.blob()).size;
        }
        const megabytes = bytes / (1024 * 1024);
        statusElement.textContent = `Tiles: ${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB · ${requests.length}`;
      } catch {
        statusElement.textContent = "Tiles: unavailable";
      }
    }
    function scheduleRefresh() {
      window.clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), 1200);
    }
    layers.forEach((layer) => layer.on("load", scheduleRefresh));
    void refresh();
    window.setInterval(() => void refresh(), 120000);
  }

  function createUserLocationTracker(map, markerOptions = {}) {
    let marker = null;
    let accuracyCircle = null;
    let watchId = null;
    let lastKnownLatLng = null;

    function upsert(latlng, accuracyMeters) {
      lastKnownLatLng = latlng;
      if (!marker) {
        marker = L.marker(latlng, {
          icon: L.icon({ iconUrl: "/person-marker.svg?v=20260721e", iconSize: [36, 36], iconAnchor: [18, 30] }),
          interactive: false,
          ...markerOptions
        }).addTo(map);
      } else {
        marker.setLatLng(latlng);
      }
      if (!accuracyCircle) {
        accuracyCircle = L.circle(latlng, { radius: accuracyMeters, color: "#2563eb", fillColor: "#60a5fa", fillOpacity: 0.14, weight: 1 }).addTo(map);
      } else {
        accuracyCircle.setLatLng(latlng);
        accuracyCircle.setRadius(accuracyMeters);
      }
    }

    async function requestCurrentLocation() {
      const capacitor = window.Capacitor;
      const geoPlugin = capacitor?.Plugins?.Geolocation;
      const isNative = typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform();
      if (isNative && geoPlugin) {
        try {
          await geoPlugin.requestPermissions();
          return await geoPlugin.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 });
        } catch {
          // Fall through to the browser implementation.
        }
      }
      if (!navigator.geolocation) return null;
      return new Promise((resolve) => navigator.geolocation.getCurrentPosition(
        (position) => resolve(position), () => resolve(null), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      ));
    }

    async function start() {
      const firstPosition = await requestCurrentLocation();
      if (firstPosition?.coords) upsert(L.latLng(firstPosition.coords.latitude, firstPosition.coords.longitude), firstPosition.coords.accuracy || 0);
      const capacitor = window.Capacitor;
      const geoPlugin = capacitor?.Plugins?.Geolocation;
      const isNative = typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform();
      if (isNative && geoPlugin) {
        try {
          await geoPlugin.requestPermissions();
          watchId = await geoPlugin.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }, (position, error) => {
            if (!error && position?.coords) upsert(L.latLng(position.coords.latitude, position.coords.longitude), position.coords.accuracy || 0);
          });
          return;
        } catch {
          // Fall through to browser watching.
        }
      }
      if (navigator.geolocation) {
        watchId = navigator.geolocation.watchPosition(
          (position) => upsert(L.latLng(position.coords.latitude, position.coords.longitude), position.coords.accuracy || 0),
          () => {}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
        );
      }
    }

    async function focus() {
      if (lastKnownLatLng) {
        map.flyTo(lastKnownLatLng, Math.max(map.getZoom(), 15), { duration: 0.6 });
        return;
      }
      const position = await requestCurrentLocation();
      if (position?.coords) {
        const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
        upsert(latlng, position.coords.accuracy || 0);
        map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.6 });
      }
    }

    function stop() {
      if (typeof watchId === "number") navigator.geolocation?.clearWatch?.(watchId);
      watchId = null;
    }

    return { start, focus, stop };
  }

  window.CensusMapRuntime = { readMapUrlState, bindMapUrlState, setupBaseMap, setupTileCacheStatus, createUserLocationTracker };
})();
