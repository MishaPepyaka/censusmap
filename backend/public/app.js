(async function initViewer() {
  const routeMatch = window.location.pathname.match(/^\/(\d+)(?:\/)?$/);
  const cld = routeMatch ? routeMatch[1] : "";
  if (!cld) {
    window.location.replace("/");
    return;
  }
  const mapUrlParams = new URLSearchParams(window.location.search);
  const requestedZoomValue = mapUrlParams.get("zoom");
  const requestedZoom = requestedZoomValue === null ? null : Number(requestedZoomValue);
  const requestedLatValue = mapUrlParams.get("lat");
  const requestedLngValue = mapUrlParams.get("lng");
  const requestedLat = requestedLatValue === null ? null : Number(requestedLatValue);
  const requestedLng = requestedLngValue === null ? null : Number(requestedLngValue);
  const hasRequestedCenter = Number.isFinite(requestedLat)
    && Number.isFinite(requestedLng)
    && requestedLat >= -90 && requestedLat <= 90
    && requestedLng >= -180 && requestedLng <= 180;

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The viewer still works online if a browser disallows service workers.
    });
  }

  let selectedPolygonLayer = null;
  let selectedDwellingMarker = null;
  let userMarker = null;
  let userAccuracy = null;
  let locationWatchId = null;
  let lastKnownLatLng = null;
  let currentBaseMode = "satellite";
  let badgesReady = false;

  const dwellingByCode = new Map();
  const dwellingByCu = new Map();
  const dwellingByNo = new Map();
  const dwellingRecords = [];
  const dwellingMarkerByKey = new Map();
  const OPENED_CASE_STATUS = "429";
  let lastDwellingSearchValue = null;
  let dwellingSearchMatchIndex = 0;

  const routeLabel = document.getElementById("route-label");
  const routeSubtitle = document.getElementById("route-subtitle");
  const editRouteLink = document.getElementById("edit-route-link");
  const locateBtn = document.getElementById("locate-btn");
  const baseMapBtn = document.getElementById("basemap-btn");
  const searchInput = document.getElementById("dwelling-search-input");
  const searchBtn = document.getElementById("dwelling-search-btn");
  const searchStatus = document.getElementById("dwelling-search-status");
  const tileCacheStatus = document.getElementById("tile-cache-status");
  let currentUser = null;

  let tileCacheRefreshTimer = null;
  async function refreshTileCacheStatus() {
    if (!tileCacheStatus) return;
    if (!("caches" in window)) {
      tileCacheStatus.textContent = "Tiles: unavailable";
      return;
    }
    try {
      const cache = await caches.open("cmp-map-tiles-v1");
      const requests = await cache.keys();
      const sizes = await Promise.all(requests.map(async (request) => {
        const response = await cache.match(request);
        if (!response) return 0;
        const length = Number(response.headers.get("content-length"));
        return Number.isFinite(length) && length >= 0 ? length : (await response.blob()).size;
      }));
      const bytes = sizes.reduce((total, size) => total + size, 0);
      const megabytes = bytes / (1024 * 1024);
      tileCacheStatus.textContent = `Tiles: ${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB · ${requests.length}`;
    } catch {
      tileCacheStatus.textContent = "Tiles: unavailable";
    }
  }

  function scheduleTileCacheStatusRefresh() {
    window.clearTimeout(tileCacheRefreshTimer);
    tileCacheRefreshTimer = window.setTimeout(() => {
      void refreshTileCacheStatus();
    }, 1200);
  }

  async function loadCurrentUser() {
    try {
      const response = await fetch("/api/me");
      if (!response.ok) return;
      const payload = await response.json();
      currentUser = payload.user || null;
    } catch {
      currentUser = null;
    }
  }

  function isNonEmpty(value) {
    return value !== undefined && value !== null && String(value).trim().length > 0;
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function isPolygonGeometry(geometry) {
    return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
  }

  function isPointGeometry(geometry) {
    return geometry?.type === "Point";
  }

  function hasDwellingIdentifier(props) {
    return isNonEmpty(props?.dwellingNo) || isNonEmpty(props?.DWELLING_NO) || isNonEmpty(props?.vrNumber) || isNonEmpty(props?.VR_NUMBER);
  }

  function getZoneKind(props) {
    const group = String(props?._group || "").trim().toLowerCase();
    if (group === "cu" || group === "cus") return "cu";
    if (group === "blocks" || group === "block") return "block";
    if (isNonEmpty(props?.COLB_UID) || isNonEmpty(props?.CB_COLCODE)) return "block";
    if (isNonEmpty(props?.CU_TYPE) || isNonEmpty(props?.CUID) || isNonEmpty(props?.cu)) return "cu";
    return "";
  }

  function isZoneFeature(feature) {
    const props = feature?.properties || {};
    const geometry = feature?.geometry || {};
    return isPolygonGeometry(geometry) && (getZoneKind(props) === "cu" || getZoneKind(props) === "block");
  }

  function isDwellingFeature(props, geometry) {
    if (!props || typeof props !== "object") return false;
    const group = String(props._group || "").trim().toLowerCase();
    if (!isPointGeometry(geometry)) return false;
    if (group === "special_locations") return false;
    if (group === "dwellings" || group === "dwelling") return true;
    return hasDwellingIdentifier(props);
  }

  function isSpecialLocationFeature(props, geometry) {
    return isPointGeometry(geometry) && String(props?._group || "").trim().toLowerCase() === "special_locations";
  }

  function extractCuCode(props) {
    if (isNonEmpty(props.CUID)) return String(props.CUID).trim();
    if (isNonEmpty(props.cu)) return String(props.cu).trim();
    if (isNonEmpty(props.name)) return String(props.name).split("/")[0].trim();
    if (isNonEmpty(props.label)) return String(props.label).split("/")[0].trim();
    return "UNKNOWN";
  }

  function extractBlockCode(props) {
    if (isNonEmpty(props.CB_COLCODE)) return String(props.CB_COLCODE).trim().padStart(2, "0");
    if (isNonEmpty(props.block)) return String(props.block).trim().padStart(2, "0");
    if (isNonEmpty(props.GEOCODE)) return String(props.GEOCODE).trim().slice(-2);
    const fromName = isNonEmpty(props.name) ? String(props.name).split("/")[1] : "";
    return fromName && fromName.trim().length > 0 ? fromName.trim().padStart(2, "0") : "";
  }

  function extractDwellingNo(props) {
    const raw = props.dwellingNo ?? props.DWELLING_NO ?? props.vrNumber ?? props.VR_NUMBER;
    if (!isNonEmpty(raw)) return "0000";
    return String(raw).trim().replace(/\D/g, "").padStart(4, "0").slice(-4);
  }

  function displayDwellingNo(props) {
    const normalized = extractDwellingNo(props);
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? String(numeric) : normalized;
  }

  function normalizeDwellingStatus(value) {
    const status = String(value ?? "").trim();
    return ["429", "400", "402", "701", "500", "312", "324"].includes(status) ? status : "429";
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
  }

  function formatSsidDisplay(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length !== 8) return String(value || "").trim();
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}`;
  }

  function buildColorMap(cuCodes) {
    const unique = [...new Set(cuCodes)].sort();
    const map = new Map();
    const variants = [
      { strokeS: 78, strokeL: 28, fillS: 82, fillL: 52 },
      { strokeS: 72, strokeL: 34, fillS: 76, fillL: 60 },
      { strokeS: 86, strokeL: 24, fillS: 88, fillL: 48 },
      { strokeS: 68, strokeL: 30, fillS: 72, fillL: 56 }
    ];
    for (let i = 0; i < unique.length; i += 1) {
      const code = unique[i];
      const seed = hashText(code);
      const orderHue = (i * 137.508) % 360;
      const hueJitter = (seed % 31) - 15;
      const hue = Math.round((orderHue + hueJitter + 360) % 360);
      const variant = variants[seed % variants.length];
      map.set(code, {
        stroke: `hsl(${hue} ${variant.strokeS}% ${variant.strokeL}%)`,
        fill: `hsl(${hue} ${variant.fillS}% ${variant.fillL}%)`
      });
    }
    return map;
  }

  async function getJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  function parseFeatures(payload) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    return {
      zones: features.filter((feature) => isZoneFeature(feature)),
      dwellings: features.filter((feature) => isDwellingFeature(feature.properties || {}, feature.geometry || {})),
      specialLocations: features.filter((feature) => isSpecialLocationFeature(feature.properties || {}, feature.geometry || {}))
    };
  }

  function buildFeatureCollection(features) {
    return {
      type: "FeatureCollection",
      features: Array.isArray(features) ? features : []
    };
  }

  async function loadRegionSummary() {
    try {
      return await getJson(`/api/cld/${cld}`);
    } catch (error) {
      return {
        cld,
        label: `CLD ${cld}`,
        ssids: [],
        counts: { cu: 0, blocks: 0, dwellings: 0 },
        loadError: error.message
      };
    }
  }

  async function getMapData() {
    try {
      const apiData = await getJson(`/api/cld/${cld}/features`);
      const features = Array.isArray(apiData.features) ? apiData.features : [];
      try {
        await window.CldOfflineStore?.saveSnapshot(cld, features);
      } catch {
        // A storage quota error must not prevent the online map from loading.
      }
      return { ...parseFeatures(apiData), loadError: "" };
    } catch (error) {
      try {
        const snapshot = await window.CldOfflineStore?.readSnapshot(cld);
        if (Array.isArray(snapshot?.features)) {
          return {
            ...parseFeatures({ features: snapshot.features }),
            loadError: "Offline: showing the last map saved on this device."
          };
        }
      } catch {
        // Fall through to the explicit no-snapshot state.
      }
      return {
        zones: [],
        dwellings: [],
        specialLocations: [],
        loadError: navigator.onLine
          ? `Map data could not be loaded: ${error.message}`
          : "Offline: application shell is ready. Connect once to download this CLD for offline use."
      };
    }
  }

  function getZoneCenter(layer) {
    if (typeof layer.getCenter === "function") {
      try {
        return layer.getCenter();
      } catch {
        return layer.getBounds().getCenter();
      }
    }
    return layer.getBounds().getCenter();
  }

  function normalizeSearchCode(value) {
    return String(value || "").replace(/\D/g, "");
  }

  function getGoogleMapsLink(lat, lng) {
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  function getAppleMapsLink(lat, lng) {
    return `https://maps.apple.com/?ll=${lat.toFixed(6)},${lng.toFixed(6)}&q=${lat.toFixed(6)},${lng.toFixed(6)}`;
  }

  const MAP_ACTION_ICONS = {
    share: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 15V3m0 0 4 4m-4-4-4 4M5 10.5v7.75A1.75 1.75 0 0 0 6.75 20h10.5A1.75 1.75 0 0 0 19 18.25V10.5"/></svg>`,
    google: `<img src="/map-action-icons/google-maps.png" alt="">`,
    apple: `<img src="/map-action-icons/apple-maps.png" alt="">`
  };

  function buildMapActionButtons(lat, lng, shareTitle, inline = false) {
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return "";
    const googleUrl = getGoogleMapsLink(lat, lng);
    const appleUrl = getAppleMapsLink(lat, lng);
    return [
      `<div class="dw-popup-actions${inline ? " dw-popup-actions-inline" : ""}">`,
      `<button type="button" class="dw-action-btn dw-action-icon dw-action-share" data-title="${escapeHtml(shareTitle)}" aria-label="Share page link" title="Share page link">${MAP_ACTION_ICONS.share}</button>`,
      `<a class="dw-action-btn dw-action-icon dw-action-google" href="${escapeHtml(googleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Google Maps" title="Open in Google Maps">${MAP_ACTION_ICONS.google}</a>`,
      `<a class="dw-action-btn dw-action-icon dw-action-apple" href="${escapeHtml(appleUrl)}" target="_blank" rel="noreferrer" aria-label="Open in Apple Maps" title="Open in Apple Maps">${MAP_ACTION_ICONS.apple}</a>`,
      `</div>`
    ].join("");
  }

  function attachMapActionHandlers(root) {
    const shareBtn = root?.querySelector(".dw-action-share");
    if (!shareBtn) return;
    shareBtn.addEventListener("click", async (shareEvent) => {
      shareEvent.preventDefault();
      const url = window.location.href;
      const title = shareBtn.getAttribute("data-title") || "Map location";
      try {
        if (navigator.share) {
          await navigator.share({ title, text: title, url });
        } else if (navigator.clipboard?.writeText) {
          await navigator.clipboard.writeText(url);
          let copyStatus = root.querySelector(".dw-popup-share-status");
          if (!copyStatus) {
            copyStatus = document.createElement("div");
            copyStatus.className = "dw-popup-share-status";
            copyStatus.setAttribute("role", "status");
            copyStatus.setAttribute("aria-live", "polite");
            (root.querySelector(".dw-popup") || root).append(copyStatus);
          }
          copyStatus.textContent = "✓ Link copied";
          copyStatus.hidden = false;
          shareBtn.classList.add("is-copied");
          shareBtn.title = "Link copied";
          window.setTimeout(() => {
            copyStatus.hidden = true;
            shareBtn.classList.remove("is-copied");
            shareBtn.title = "Share page link";
          }, 1200);
        } else {
          window.prompt("Copy link:", url);
        }
      } catch {
        // Ignore share cancellation.
      }
    }, { once: true });
  }

  function setSearchStatus(message, isError = false) {
    if (!searchStatus) return;
    searchStatus.textContent = message || "";
    searchStatus.classList.toggle("search-status-error", Boolean(isError));
  }

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true
  }).setView([56.0, -96.0], 4);

  function syncMapUrl() {
    const center = map.getCenter();
    const params = new URLSearchParams(window.location.search);
    params.set("zoom", String(Math.round(map.getZoom())));
    params.set("lat", center.lat.toFixed(6));
    params.set("lng", center.lng.toFixed(6));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
    if (editRouteLink) editRouteLink.href = `/${cld}/edit?${query}`;
  }

  function applyRequestedMapView() {
    if (hasRequestedCenter) {
      const zoom = Number.isFinite(requestedZoom) ? Math.max(0, Math.min(22, requestedZoom)) : map.getZoom();
      map.setView([requestedLat, requestedLng], zoom);
    } else if (Number.isFinite(requestedZoom)) {
      map.setZoom(Math.max(0, Math.min(22, requestedZoom)));
    }
    syncMapUrl();
  }

  map.on("zoomend moveend", syncMapUrl);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const vectorRenderer = L.svg({ padding: 0.5 });

  const mapContainer = map.getContainer();
  function syncZoomUiMode() {
    const cuOnly = map.getZoom() <= 10;
    mapContainer.classList.toggle("zoom-cu-only", cuOnly);
    if (badgesReady) rebuildBadges();
  }
  map.on("zoomend", syncZoomUiMode);
  syncZoomUiMode();

  const satelliteLayer = L.tileLayer(
    "/tiles/satellite/{z}/{y}/{x}",
    {
      maxZoom: 22,
      maxNativeZoom: 17,
      attribution: "Tiles &copy; Esri"
    }
  );
  const schematicLayer = L.tileLayer("/tiles/schematic/{z}/{y}/{x}", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  satelliteLayer.addTo(map);
  satelliteLayer.on("load", scheduleTileCacheStatusRefresh);
  schematicLayer.on("load", scheduleTileCacheStatusRefresh);
  void refreshTileCacheStatus();
  window.setInterval(() => void refreshTileCacheStatus(), 30000);

  function setBaseMode(mode) {
    if (mode === currentBaseMode) return;
    if (mode === "satellite") {
      map.removeLayer(schematicLayer);
      map.addLayer(satelliteLayer);
      currentBaseMode = "satellite";
      return;
    }
    map.removeLayer(satelliteLayer);
    map.addLayer(schematicLayer);
    currentBaseMode = "schematic";
  }

  function toggleBaseMode() {
    setBaseMode(currentBaseMode === "satellite" ? "schematic" : "satellite");
    const modeLabel = currentBaseMode === "satellite" ? "Satellite" : "Schematic";
    baseMapBtn?.setAttribute("title", `Switch base map (current: ${modeLabel})`);
    baseMapBtn?.setAttribute("aria-label", `Switch base map (current: ${modeLabel})`);
  }

  async function focusUserLocation() {
    if (lastKnownLatLng) {
      map.flyTo(lastKnownLatLng, Math.max(map.getZoom(), 15), { duration: 0.6 });
      return;
    }
    const position = await requestCurrentLocation();
    if (position) {
      const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
      upsertUserLocation(latlng, position.coords.accuracy || 0);
      map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.6 });
    }
  }

  if (locateBtn) {
    locateBtn.textContent = "🧍";
    locateBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await focusUserLocation();
    });
  }

  if (baseMapBtn) {
    baseMapBtn.textContent = "🗺️";
    baseMapBtn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleBaseMode();
    });
  }

  await loadCurrentUser();
  if (editRouteLink) {
    const canEdit = Boolean(currentUser?.isAdmin || currentUser?.role === "crew_leader");
    editRouteLink.href = `/${cld}/edit`;
    editRouteLink.hidden = !canEdit;
  }

  const summary = await loadRegionSummary();
  const mapData = await getMapData();
  routeLabel.textContent = summary.label || `CLD ${cld}`;

  const zones = mapData.zones;
  const dwellings = mapData.dwellings;
  const specialLocations = mapData.specialLocations;
  function updateRouteSubtitle() {
    const records = dwellingRecords.length ? dwellingRecords : dwellings;
    const closedCases = records.filter((item) => {
      const status = "status" in item ? item.status : item?.properties?.status;
      return normalizeDwellingStatus(status) !== OPENED_CASE_STATUS;
    }).length;
    const closedPercent = records.length ? ((closedCases / records.length) * 100).toFixed(1) : "0.0";
    const summaryText = `${summary.counts?.cu || 0} CU · ${summary.counts?.blocks || 0} blocks · ${records.length} dwellings · ${closedCases} completed (${closedPercent}%)`;
    routeSubtitle.textContent = mapData.loadError ? `${summaryText} · ${mapData.loadError}` : summaryText;
  }
  updateRouteSubtitle();
  const cuCodes = zones.map((feature) => extractCuCode(feature.properties || {}));
  const colorMap = buildColorMap(cuCodes);
  const BLOCK_FILL_TRANSITION_ZOOM = 15;
  const BLOCK_FILL_FADE_ZOOM = 18;

  function blockFillOpacity(selected) {
    const zoom = map.getZoom();
    if (zoom >= BLOCK_FILL_FADE_ZOOM) return selected ? 0.14 : 0.07;
    if (zoom >= BLOCK_FILL_TRANSITION_ZOOM) return selected ? 0.24 : 0.16;
    return selected ? 0.34 : 0.2;
  }

  function styleForFeature(feature, selected) {
    const props = feature?.properties || {};
    const cu = extractCuCode(props);
    const color = colorMap.get(cu) || { stroke: "#15803d", fill: "#22c55e" };
    const zoneKind = getZoneKind(props);
    const isCu = zoneKind === "cu";
    return {
      color: color.stroke,
      fillColor: color.fill,
      fillOpacity: isCu ? (selected ? 0.18 : 0.08) : blockFillOpacity(selected),
      weight: selected ? 4 : (isCu ? 3 : 2),
      dashArray: isCu ? "8 6" : null,
      opacity: 0.95
    };
  }

  const polygonLayer = L.geoJSON(null, {
    renderer: vectorRenderer,
    style: (feature) => styleForFeature(feature, false)
  }).addTo(map);

  const badgeLayer = L.layerGroup().addTo(map);
  const dwellingsLayer = L.layerGroup().addTo(map);
  const specialLocationsLayer = L.layerGroup().addTo(map);
  const dwellingClusterLayer = L.layerGroup().addTo(map);
  polygonLayer.addData(buildFeatureCollection(zones));

  function selectZone(layer, popupLatLng = null) {
    if (selectedPolygonLayer && selectedPolygonLayer !== layer) {
      selectedPolygonLayer.setStyle(styleForFeature(selectedPolygonLayer.feature, false));
    }
    selectedPolygonLayer = layer;
    selectedPolygonLayer.setStyle(styleForFeature(selectedPolygonLayer.feature, true));
    const props = layer.feature?.properties || {};
    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const zoneKind = getZoneKind(props) === "cu" ? "CU" : "Block";
    const details = block ? `${zoneKind}: ${escapeHtml(block)}` : zoneKind;
    const point = popupLatLng || getZoneCenter(layer);
    const shareTitle = block ? `Block ${cu}/${block}` : `CU ${cu}`;
    layer.bindPopup([
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(shareTitle)}</div>`,
      `<div class="dw-popup-meta">CU: ${escapeHtml(cu)}<br>${details}</div>`,
      buildMapActionButtons(point.lat, point.lng, shareTitle),
      `</div>`
    ].join(""), { autoPan: false });
    if (popupLatLng) layer.openPopup(popupLatLng);
    else layer.openPopup();
  }

  function rebuildBadges() {
    badgeLayer.clearLayers();
    const currentZoom = map.getZoom();
    if (currentZoom <= 12 || currentZoom >= 16) return;
    polygonLayer.eachLayer((layer) => {
      const props = layer.feature?.properties || {};
      const zoneKind = getZoneKind(props);
      if (zoneKind !== "block") return;
      const cu = extractCuCode(props);
      const code = extractBlockCode(props);
      const center = getZoneCenter(layer);
      const icon = L.divIcon({
        className: "zone-chip-wrap",
        html: `<span class="zone-chip"><span class="block-badge">${escapeHtml(code || "CU")}</span><span class="zone-chip-text">${escapeHtml(cu)}</span></span>`,
        iconAnchor: [12, 12]
      });
      L.marker(center, { icon, interactive: false }).addTo(badgeLayer);
    });
  }

  polygonLayer.eachLayer((layer) => {
    layer.on("click", (event) => selectZone(layer, event?.latlng || null));
    layer.on("tap", (event) => selectZone(layer, event?.latlng || null));
    layer.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
      attachMapActionHandlers(root);
    });
  });
  badgesReady = true;
  rebuildBadges();

  function redrawPolygonLayers() {
    polygonLayer.eachLayer((layer) => {
      layer.setStyle?.(styleForFeature(layer.feature, layer === selectedPolygonLayer));
      layer.redraw?.();
    });
    if (badgesReady) rebuildBadges();
  }
  map.on("zoomend", redrawPolygonLayers);
  map.on("moveend", redrawPolygonLayers);
  map.on("viewreset", redrawPolygonLayers);

  function dwellingSquareIcon(no, status, selected = false) {
    const cls = `dwelling-marker dwelling-status-${normalizeDwellingStatus(status)} ${selected ? "selected" : ""}`;
    return L.divIcon({
      className: "dwelling-marker-wrap",
      html: `<span class="${cls}">${escapeHtml(no)}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  function dwellingDotIcon(status, selected = false) {
    const cls = `dwelling-square-dot dwelling-status-${normalizeDwellingStatus(status)} ${selected ? "selected" : ""}`;
    return L.divIcon({
      className: "dwelling-square-dot-wrap",
      html: `<span class="${cls}"></span>`,
      iconSize: [12, 12],
      iconAnchor: [6, 6]
    });
  }

  function getDwellingIconForZoom(no, status, selected = false) {
    if (map.getZoom() >= 15) {
      return dwellingSquareIcon(no, status, selected);
    }
    return dwellingDotIcon(status, selected);
  }

  function iconForDwellingMarker(marker, selected) {
    const info = marker?.__dwellingInfo || {};
    return marker?.__forceSquareIcon
      ? dwellingSquareIcon(info.displayNo || "0", info.status, selected)
      : getDwellingIconForZoom(info.displayNo || "0", info.status, selected);
  }

  function setSelectedDwelling(marker) {
    if (selectedDwellingMarker && selectedDwellingMarker !== marker) {
      selectedDwellingMarker.setIcon(iconForDwellingMarker(selectedDwellingMarker, false));
    }
    selectedDwellingMarker = marker;
    if (selectedDwellingMarker) {
      selectedDwellingMarker.setIcon(iconForDwellingMarker(selectedDwellingMarker, true));
    }
  }

  function buildDwellingPopupHtml(info) {
    const notes = String(info.notes || "").trim();
    const statusOptions = ["429", "400", "402", "701", "500", "312", "324"]
      .map((status) => `<option value="${status}"${status === info.status ? " selected" : ""}>${status}</option>`)
      .join("");
    return [
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(info.code)}</div>`,
      `<div class="dw-popup-meta">CU ${escapeHtml(info.cu)} · Block ${escapeHtml(info.block)} · Dwelling ${escapeHtml(info.displayNo)}</div>`,
      notes ? `<div class="dw-popup-notes"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : "",
      `<div class="dw-popup-status-row">`,
      `<label class="dw-popup-status">Status <select class="dw-status-select" data-key="${escapeHtml(info.key)}">${statusOptions}</select></label>`,
      buildMapActionButtons(info.lat, info.lng, `Dwelling ${info.code}`, true),
      `</div>`,
      `</div>`
    ].join("");
  }

  function registerDwellingRecord(record) {
    if (!dwellingByCode.has(record.code)) dwellingByCode.set(record.code, []);
    dwellingByCode.get(record.code).push(record);
    if (!dwellingByCu.has(record.cu)) dwellingByCu.set(record.cu, []);
    dwellingByCu.get(record.cu).push(record);
    if (!dwellingByNo.has(record.no)) dwellingByNo.set(record.no, []);
    dwellingByNo.get(record.no).push(record);
  }

  function buildDwellingRecord(feature, index) {
    const props = feature?.properties || {};
    const geom = feature?.geometry || {};
    if (geom.type !== "Point" || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) return null;
    const lng = Number(geom.coordinates[0]);
    const lat = Number(geom.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const no = extractDwellingNo(props);
    const displayNo = displayDwellingNo(props);
    const code = `${cu}${no}`;
    const gmapsUrl = getGoogleMapsLink(lat, lng);
    const key = [cu, block, no, lat.toFixed(6), lng.toFixed(6), index].join(":");
    return {
      key,
      cu,
      block,
      no,
      displayNo,
      code,
      gmapsUrl,
      lat,
      lng,
      status: normalizeDwellingStatus(props.status),
      notes: props.notes || "",
      featureId: Number.isFinite(Number(feature?.id)) ? Number(feature.id) : null,
      properties: { ...props },
      geometry: { type: "Point", coordinates: [lng, lat] }
    };
  }

  function createDwellingMarker(record, forceSquareIcon = false) {
    const marker = L.marker([record.lat, record.lng], {
      icon: forceSquareIcon
        ? dwellingSquareIcon(record.displayNo, record.status, false)
        : getDwellingIconForZoom(record.displayNo, record.status, false),
      keyboard: true
    }).addTo(dwellingsLayer);
    marker.__dwellingInfo = record;
    marker.__forceSquareIcon = forceSquareIcon;
    marker.bindPopup(buildDwellingPopupHtml(record), { autoPan: true });
    marker.on("click", () => setSelectedDwelling(marker));
    marker.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
      attachMapActionHandlers(root);

      const statusSelect = root?.querySelector(".dw-status-select");
      statusSelect?.addEventListener("change", async () => {
        const previousStatus = record.status;
        const nextStatus = normalizeDwellingStatus(statusSelect.value);
        if (nextStatus === previousStatus) return;
        if (!Number.isFinite(record.featureId)) {
          statusSelect.value = previousStatus;
          setSearchStatus("This dwelling cannot be updated because it has no feature id.", true);
          return;
        }
        statusSelect.disabled = true;
        record.status = nextStatus;
        marker.setIcon(iconForDwellingMarker(marker, marker === selectedDwellingMarker));
        try {
          await getJson(`/api/cld/${cld}/features/${record.featureId}`, {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              type: "Feature",
              id: record.featureId,
              properties: { ...record.properties, status: nextStatus },
              geometry: record.geometry
            })
          });
          record.properties.status = nextStatus;
          updateRouteSubtitle();
          setSearchStatus(`Status for ${record.code} saved.`, false);
        } catch (error) {
          record.status = previousStatus;
          statusSelect.value = previousStatus;
          marker.setIcon(iconForDwellingMarker(marker, marker === selectedDwellingMarker));
          setSearchStatus(`Status save failed: ${error.message}`, true);
        } finally {
          statusSelect.disabled = false;
        }
      });
    });

    dwellingMarkerByKey.set(record.key, marker);
    return marker;
  }

  const SPECIAL_LOCATION_ICONS = {
    band_hall: "band_hall.svg",
    stadium: "stadium.svg",
    cafe: "local_cafe.svg",
    gas_station: "gas_station.svg",
    arena: "stadium.svg",
    cultural: "cultural.svg",
    church: "church.svg",
    band_office: "band_office.svg",
    health_office: "health_office.svg",
    radio_tower: "radio_tower.svg",
    school: "school.svg",
    other: "other.svg"
  };
  const SPECIAL_LOCATIONS_MIN_VISIBLE_ZOOM = 10;

  function syncSpecialLocationVisibility() {
    const visible = map.getZoom() >= SPECIAL_LOCATIONS_MIN_VISIBLE_ZOOM;
    specialLocationsLayer.eachLayer((marker) => {
      marker.setOpacity(visible ? 1 : 0);
      const element = marker.getElement?.();
      if (element) element.style.pointerEvents = visible ? "" : "none";
    });
  }

  function specialLocationIcon(type) {
    const asset = SPECIAL_LOCATION_ICONS[type] || SPECIAL_LOCATION_ICONS.other;
    return L.divIcon({
      className: "special-location-marker-wrap",
      html: `<span class="special-location-marker"><img src="/place-icons/${asset}" alt=""></span>`,
      iconSize: [30, 30],
      iconAnchor: [15, 15]
    });
  }

  function createSpecialLocationMarker(feature) {
    const coordinates = feature?.geometry?.coordinates || [];
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const props = feature.properties || {};
    const name = String(props.name || props.label || "Special location").trim();
    const type = String(props.locationType || "other").trim();
    const notes = String(props.notes || "").trim();
    const marker = L.marker([lat, lng], { icon: specialLocationIcon(type), keyboard: true })
      .bindPopup([
        `<div class="dw-popup">`,
        `<div class="dw-popup-code">${escapeHtml(name)}</div>`,
        `<div class="dw-popup-meta">${escapeHtml(type.replaceAll("_", " "))}</div>`,
        notes ? `<div class="dw-popup-notes"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : "",
        buildMapActionButtons(lat, lng, name),
        `</div>`
      ].join(""), { autoPan: true })
      .addTo(specialLocationsLayer);
    marker.on("popupopen", (event) => {
      attachMapActionHandlers(event?.popup?.getElement?.());
    });
  }

  const DWELLINGS_MIN_VISIBLE_ZOOM = 10;
  const DWELLINGS_INDIVIDUAL_ZOOM = 15;

  function dwellingClusterLabel(records) {
    const numbers = records.map((record) => Number(record.no)).filter(Number.isFinite).sort((a, b) => a - b);
    if (numbers.length === 0) return String(records.length);
    return numbers[0] === numbers[numbers.length - 1] ? String(numbers[0]) : `${numbers[0]}–${numbers[numbers.length - 1]}`;
  }

  function isCompletedDwellingCluster(records) {
    const completedStatuses = new Set(["400", "402", "701", "312", "324"]);
    return records.length > 0 && records.every((record) => completedStatuses.has(normalizeDwellingStatus(record.status)));
  }

  function splitConsecutiveDwellingRecords(records) {
    const ordered = [...records].sort((a, b) => Number(a.no) - Number(b.no));
    return ordered.reduce((groups, record) => {
      const lastGroup = groups[groups.length - 1];
      const previous = lastGroup?.[lastGroup.length - 1];
      if (previous && Number(record.no) === Number(previous.no) + 1) {
        lastGroup.push(record);
      } else {
        groups.push([record]);
      }
      return groups;
    }, []);
  }

  function renderDwellingClusters() {
    const buckets = new Map();
    for (const record of dwellingRecords) {
      const point = map.project([record.lat, record.lng], map.getZoom());
      const key = `${record.cu}:${Math.floor(point.x / 72)}:${Math.floor(point.y / 72)}`;
      const bucket = buckets.get(key) || [];
      bucket.push(record);
      buckets.set(key, bucket);
    }
    for (const bucket of buckets.values()) {
      for (const records of splitConsecutiveDwellingRecords(bucket)) {
        if (records.length === 1) {
          createDwellingMarker(records[0], true);
          continue;
        }
        const bounds = L.latLngBounds(records.map((record) => [record.lat, record.lng]));
        const completed = isCompletedDwellingCluster(records);
        L.marker(bounds.getCenter(), {
          icon: L.divIcon({
            className: "dwelling-cluster-wrap",
            html: `<span class="dwelling-cluster${completed ? " dwelling-cluster-completed" : ""}">${escapeHtml(dwellingClusterLabel(records))}</span>`,
            iconAnchor: [35, 15]
          })
        }).on("click", () => map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })).addTo(dwellingClusterLayer);
      }
    }
  }

  function renderVisibleDwellingMarkers() {
    const selectedKey = selectedDwellingMarker?.__dwellingInfo?.key || null;
    dwellingsLayer.clearLayers();
    dwellingClusterLayer.clearLayers();
    dwellingMarkerByKey.clear();
    selectedDwellingMarker = null;

    if (map.getZoom() < DWELLINGS_MIN_VISIBLE_ZOOM) {
      return;
    }

    if (map.getZoom() < DWELLINGS_INDIVIDUAL_ZOOM) {
      renderDwellingClusters();
      return;
    }

    for (const record of dwellingRecords) {
      const marker = createDwellingMarker(record);
      if (!marker) continue;
      if (record.key === selectedKey) {
        setSelectedDwelling(marker);
      }
    }
  }

  for (let index = 0; index < dwellings.length; index += 1) {
    const record = buildDwellingRecord(dwellings[index], index);
    if (!record) continue;
    dwellingRecords.push(record);
    registerDwellingRecord(record);
  }
  for (const feature of specialLocations) createSpecialLocationMarker(feature);
  syncSpecialLocationVisibility();
  renderVisibleDwellingMarkers();
  map.on("zoomend", renderVisibleDwellingMarkers);
  map.on("zoomend", syncSpecialLocationVisibility);

  function focusDwelling(record, setStatusText = true) {
    if (!record) return;
    if (map.getZoom() < DWELLINGS_INDIVIDUAL_ZOOM) {
      map.setZoom(DWELLINGS_INDIVIDUAL_ZOOM);
    }
    renderVisibleDwellingMarkers();
    const marker = dwellingMarkerByKey.get(record.key) || null;
    if (!marker) return;
    const latlng = marker.getLatLng();
    map.flyTo(latlng, Math.max(map.getZoom(), 18), { duration: 0.45 });
    setSelectedDwelling(marker);
    marker.openPopup();
    if (setStatusText) {
      setSearchStatus(`Found: ${record.code}`, false);
    }
  }

  function findDwellingByInput(value) {
    const digits = normalizeSearchCode(value);
    if (!digits) return { record: null, records: [], message: "Enter code like 462211020079", error: true };

    if (digits.length >= 12) {
      const cu = digits.slice(0, 8);
      const no = digits.slice(-4);
      const code = `${cu}${no}`;
      const list = dwellingByCode.get(code) || [];
      return list.length > 0
        ? { record: list[0], records: list, message: "", error: false }
        : { record: null, records: [], message: `Not found: ${code}`, error: true };
    }

    if (digits.length === 8) {
      const list = dwellingByCu.get(digits) || [];
      if (list.length === 0) return { record: null, records: [], message: `No dwellings in CU ${digits}`, error: true };
      return { record: list[0], records: list, message: `CU ${digits}: showing first dwelling`, error: false };
    }

    if (digits.length <= 4) {
      const no = digits.padStart(4, "0");
      const list = dwellingByNo.get(no) || [];
      if (list.length === 0) return { record: null, records: [], message: `No dwelling ${no}`, error: true };
      if (list.length > 1) return { record: list[0], records: list, message: `Multiple ${no}, showing first match`, error: false };
      return { record: list[0], records: list, message: "", error: false };
    }

    return { record: null, records: [], message: "Use 4, 8, or 12+ digits", error: true };
  }

  function handleSearch() {
    const value = String(searchInput?.value || "");
    if (value !== lastDwellingSearchValue) {
      lastDwellingSearchValue = value;
      dwellingSearchMatchIndex = 0;
    }
    const result = findDwellingByInput(value);
    if (!result.record) {
      setSearchStatus(result.message, true);
      return;
    }
    const matches = result.records || [result.record];
    const matchIndex = dwellingSearchMatchIndex % matches.length;
    const record = matches[matchIndex];
    dwellingSearchMatchIndex = (matchIndex + 1) % matches.length;
    focusDwelling(record, false);
    setSearchStatus(
      matches.length > 1 ? `Found ${matchIndex + 1} of ${matches.length}: ${record.code}` : (result.message || "Found"),
      false
    );
  }

  searchBtn?.addEventListener("click", handleSearch);
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  });
  searchInput?.addEventListener("input", () => {
    lastDwellingSearchValue = null;
    dwellingSearchMatchIndex = 0;
  });

  if (polygonLayer.getLayers().length > 0) {
    map.fitBounds(polygonLayer.getBounds(), { padding: [20, 20] });
  } else if (dwellingRecords.length > 0) {
    const bounds = L.latLngBounds(dwellingRecords.map((record) => [record.lat, record.lng]));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [20, 20] });
    }
  } else {
    setSearchStatus("No geometry or dwellings found for this CLD.", true);
  }
  applyRequestedMapView();

  function upsertUserLocation(latlng, accuracyMeters) {
    lastKnownLatLng = latlng;
    if (!userMarker) {
      const icon = L.icon({
        iconUrl: "/person-marker.svg?v=20260721e",
        iconSize: [36, 36],
        iconAnchor: [18, 30]
      });
      userMarker = L.marker(latlng, { icon, interactive: false }).addTo(map);
    } else {
      userMarker.setLatLng(latlng);
    }

    if (!userAccuracy) {
      userAccuracy = L.circle(latlng, {
        radius: accuracyMeters,
        color: "#2563eb",
        fillColor: "#60a5fa",
        fillOpacity: 0.14,
        weight: 1
      }).addTo(map);
    } else {
      userAccuracy.setLatLng(latlng);
      userAccuracy.setRadius(accuracyMeters);
    }
  }

  async function requestCurrentLocation() {
    const capacitor = window.Capacitor;
    const geoPlugin = capacitor?.Plugins?.Geolocation;
    const isNative = typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform();
    if (isNative && geoPlugin) {
      try {
        await geoPlugin.requestPermissions();
        return await geoPlugin.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        });
      } catch {
        // Fall through to browser API.
      }
    }

    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => resolve(position),
        () => resolve(null),
        { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
      );
    });
  }

  async function startNativeWatch() {
    const capacitor = window.Capacitor;
    const geoPlugin = capacitor?.Plugins?.Geolocation;
    const isNative = typeof capacitor?.isNativePlatform === "function" && capacitor.isNativePlatform();
    if (!isNative || !geoPlugin) return false;

    try {
      await geoPlugin.requestPermissions();
      locationWatchId = await geoPlugin.watchPosition(
        {
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 5000
        },
        (position, err) => {
          if (err || !position?.coords) return;
          const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
          upsertUserLocation(latlng, position.coords.accuracy || 0);
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  function startBrowserWatch() {
    if (!navigator.geolocation) return false;
    locationWatchId = navigator.geolocation.watchPosition(
      (position) => {
        if (!position?.coords) return;
        const latlng = L.latLng(position.coords.latitude, position.coords.longitude);
        upsertUserLocation(latlng, position.coords.accuracy || 0);
      },
      () => {
        // Silent on permission denial.
      },
      { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }
    );
    return true;
  }

  async function startLocationTracking() {
    const firstPosition = await requestCurrentLocation();
    if (firstPosition?.coords) {
      const latlng = L.latLng(firstPosition.coords.latitude, firstPosition.coords.longitude);
      upsertUserLocation(latlng, firstPosition.coords.accuracy || 0);
    }
    const nativeWatchStarted = await startNativeWatch();
    if (!nativeWatchStarted) {
      startBrowserWatch();
    }
  }

  await startLocationTracking();

  window.addEventListener("beforeunload", () => {
    if (typeof locationWatchId === "number" && navigator.geolocation?.clearWatch) {
      navigator.geolocation.clearWatch(locationWatchId);
    }
  });
})();
