(async function initEditor() {
  const routeMatch = window.location.pathname.match(/^\/(\d+)\/edit(?:\/)?$/);
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
      // The editor remains fully functional when a browser disallows service workers.
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
  let dwellingMovementEnabled = false;
  let specialLocationPlacementPending = false;
  let selectedSpecialLocationMarker = null;
  const dwellingMarkersById = new Map();
  const specialLocationMarkersById = new Map();
  const allDwellingMarkers = new Set();
  const allSpecialLocationMarkers = new Set();

  const statusEl = document.getElementById("editor-status");
  const editorRouteLabel = document.getElementById("editor-route-label");
  const editorViewLink = document.getElementById("editor-view-link");
  const geometryEditorLink = document.getElementById("geometry-editor-link");
  const syncStatusEl = document.getElementById("editor-sync-status");

  const collapseBtn = document.getElementById("dwellings-collapse-btn");
  const formWrap = document.getElementById("dwellings-form-wrap");
  const dwellingFields = {
    cu: document.getElementById("dwelling-cu"),
    block: document.getElementById("dwelling-block"),
    no: document.getElementById("dwelling-no"),
    status: document.getElementById("dwelling-status"),
    notes: document.getElementById("dwelling-notes")
  };
  const dwellingNewBtn = document.getElementById("dwelling-new-btn");
  const dwellingSaveBtn = document.getElementById("dwelling-save-btn");
  const dwellingSaveAllBtn = document.getElementById("dwelling-save-all-btn");
  const dwellingDeleteBtn = document.getElementById("dwelling-delete-btn");
  const dwellingExportBtn = document.getElementById("dwelling-export-btn");
  const copyOpenedSsidsBtn = document.getElementById("copy-opened-ssids-btn");
  const bulkStatusSsidsInput = document.getElementById("bulk-status-ssids");
  const bulkStatusCodeInput = document.getElementById("bulk-status-code");
  const bulkStatusApplyBtn = document.getElementById("bulk-status-apply-btn");
  const specialLocationTypeInput = document.getElementById("special-location-type");
  const specialLocationNameInput = document.getElementById("special-location-name");
  const specialLocationNotesInput = document.getElementById("special-location-notes");
  const specialLocationGroup = document.getElementById("special-location-group");
  const specialLocationPlaceBtn = document.getElementById("special-location-place-btn");
  const specialLocationSaveBtn = document.getElementById("special-location-save-btn");
  const specialLocationDeleteBtn = document.getElementById("special-location-delete-btn");
  const dwellingMoveToggle = document.getElementById("dwelling-move-toggle");
  const dirtyDwellingMarkers = new Set();

  if (editorRouteLabel) {
    editorRouteLabel.textContent = `CLD ${cld} editor`;
  }
  if (editorViewLink) {
    editorViewLink.href = `/${cld}`;
  }

  if (geometryEditorLink) {
    geometryEditorLink.href = `/${cld}/edit_geometry`;
  }

  function setSyncStatus(message, state = "saved") {
    if (!syncStatusEl) return;
    syncStatusEl.textContent = message;
    syncStatusEl.classList.toggle("pending", state === "pending");
    syncStatusEl.classList.toggle("error", state === "error");
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

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("editor-status-error", Boolean(isError));
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
    if (!props || typeof props !== "object") return "";
    const group = String(props._group || "").trim().toLowerCase();
    if (group === "cu" || group === "cus") return "cu";
    if (group === "blocks" || group === "block") return "block";
    if (isNonEmpty(props.COLB_UID) || isNonEmpty(props.CB_COLCODE)) return "block";
    if (isNonEmpty(props.CU_TYPE) || isNonEmpty(props.CUID) || isNonEmpty(props.cu)) return "cu";
    return "";
  }

  function isZoneFeature(feature) {
    const props = feature?.properties || {};
    const geometry = feature?.geometry || {};
    return isPolygonGeometry(geometry) && (getZoneKind(props) === "cu" || getZoneKind(props) === "block");
  }

  function isDwellingFeature(props, geometry) {
    if (!props || typeof props !== "object") return false;
    if (!isPointGeometry(geometry)) return false;
    const group = String(props._group || "").trim().toLowerCase();
    // Special locations are stored with the dwelling features, and older ones
    // may retain a dwelling number. Keep them out of the dwelling layer so the
    // special-location marker receives the click and its editor controls.
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

  const EXCLUDED_CU_CODES = new Set();

  function isExcludedCuFeature(feature) {
    const cu = extractCuCode(feature?.properties || {});
    return EXCLUDED_CU_CODES.has(cu);
  }

  function extractBlockCode(props) {
    if (isNonEmpty(props.CB_COLCODE)) return String(props.CB_COLCODE).trim().padStart(2, "0");
    if (isNonEmpty(props.block)) return String(props.block).trim().padStart(2, "0");
    if (isNonEmpty(props.GEOCODE)) return String(props.GEOCODE).trim().slice(-2);
    return "01";
  }

  function extractDwellingNo(props) {
    const raw = props.dwellingNo ?? props.DWELLING_NO ?? props.vrNumber ?? props.VR_NUMBER;
    if (!isNonEmpty(raw)) return "0001";
    return String(raw).trim().padStart(4, "0");
  }

  function displayDwellingNo(props) {
    const normalized = extractDwellingNo(props);
    const numeric = Number(String(normalized).replace(/\D/g, ""));
    return Number.isFinite(numeric) ? String(numeric) : normalized;
  }

  function hashText(value) {
    const text = String(value || "");
    let hash = 0;
    for (let i = 0; i < text.length; i += 1) {
      hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
    }
    return hash;
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
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  async function getMapData() {
    try {
      const data = await getJson(`/api/cld/${cld}/features`);
      const features = (data.features || []).filter((f) => !isExcludedCuFeature(f));
      try {
        await window.CldOfflineStore?.saveSnapshot(cld, features);
      } catch {
        // The existing localStorage fallback still supports a smaller snapshot.
      }
      try {
        localStorage.setItem(`cld-map-cache:${cld}`, JSON.stringify({ savedAt: Date.now(), features }));
      } catch {
        // IndexedDB remains the primary offline store.
      }
      return {
        source: "api",
        loadError: "",
        blocks: features.filter((f) => isZoneFeature(f)),
        dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {})),
        specialLocations: features.filter((f) => isSpecialLocationFeature(f.properties || {}, f.geometry || {}))
      };
    } catch (apiError) {
      try {
        const snapshot = await window.CldOfflineStore?.readSnapshot(cld);
        if (Array.isArray(snapshot?.features)) {
          const features = snapshot.features.filter((f) => !isExcludedCuFeature(f));
          return {
            source: "cache",
            loadError: "Offline: showing the last map saved on this device.",
            blocks: features.filter((f) => isZoneFeature(f)),
            dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {})),
            specialLocations: features.filter((f) => isSpecialLocationFeature(f.properties || {}, f.geometry || {}))
          };
        }
        const cached = JSON.parse(localStorage.getItem(`cld-map-cache:${cld}`) || "null");
        if (Array.isArray(cached?.features)) {
          return {
            source: "cache",
            loadError: "Offline: showing the last map saved on this device.",
            blocks: cached.features.filter((f) => isZoneFeature(f)),
            dwellings: cached.features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {})),
            specialLocations: cached.features.filter((f) => isSpecialLocationFeature(f.properties || {}, f.geometry || {}))
          };
        }
      } catch {
        // A corrupt cache must not prevent the normal error state.
      }
      return {
        source: "none",
        loadError: `Data load failed: API (${apiError.message})`,
        blocks: [],
        dwellings: [],
        specialLocations: []
      };
    }
  }

  function getZoneCenter(layer) {
    if (typeof layer.getCenter === "function") {
      try {
        return layer.getCenter();
      } catch {
        // Fall through to bounds center when layer center is unavailable.
      }
    }
    return layer.getBounds().getCenter();
  }

  function getFeatureId(feature) {
    const id = feature?.id ?? feature?.properties?._id;
    if (Number.isFinite(Number(id))) return Number(id);
    return null;
  }

  function formatDwellingNo(raw) {
    return String(raw || "").trim().replace(/\D/g, "").padStart(4, "0").slice(-4);
  }

  const DWELLING_STATUSES = new Set(["429", "400", "402", "701", "500", "312", "324"]);

  function normalizeDwellingStatus(value) {
    const status = String(value ?? "").trim();
    return DWELLING_STATUSES.has(status) ? status : "429";
  }

  function ringContainsLngLat(ring, lng, lat) {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
      const xi = Number(ring[i][0]);
      const yi = Number(ring[i][1]);
      const xj = Number(ring[j][0]);
      const yj = Number(ring[j][1]);
      if (![xi, yi, xj, yj].every(Number.isFinite)) continue;
      const intersect = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / ((yj - yi) || Number.EPSILON) + xi;
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function polygonContainsLngLat(polygon, lng, lat) {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;
    if (!ringContainsLngLat(polygon[0], lng, lat)) return false;
    for (let i = 1; i < polygon.length; i += 1) {
      if (ringContainsLngLat(polygon[i], lng, lat)) return false;
    }
    return true;
  }

  function featureContainsLatLng(feature, latlng) {
    const geometry = feature?.geometry;
    if (!geometry || !latlng) return false;
    const lng = Number(latlng.lng);
    const lat = Number(latlng.lat);
    if (!Number.isFinite(lng) || !Number.isFinite(lat)) return false;

    if (geometry.type === "Polygon") {
      return polygonContainsLngLat(geometry.coordinates, lng, lat);
    }
    if (geometry.type === "MultiPolygon" && Array.isArray(geometry.coordinates)) {
      return geometry.coordinates.some((polygon) => polygonContainsLngLat(polygon, lng, lat));
    }
    return false;
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
          shareBtn.classList.add("is-copied");
          shareBtn.title = "Link copied";
          window.setTimeout(() => {
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

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true,
    inertia: false
  }).setView([56.0, -96.0], 4);

  function syncMapUrl() {
    const center = map.getCenter();
    const params = new URLSearchParams(window.location.search);
    params.set("zoom", String(Math.round(map.getZoom())));
    params.set("lat", center.lat.toFixed(6));
    params.set("lng", center.lng.toFixed(6));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
    if (editorViewLink) editorViewLink.href = `/${cld}?${query}`;
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
  const userLocationPane = map.createPane("user-location-pane");
  userLocationPane.style.zIndex = "650";
  userLocationPane.style.pointerEvents = "none";
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
    "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
    {
      maxZoom: 22,
      maxNativeZoom: 17,
      attribution: "Tiles &copy; Esri"
    }
  );
  const schematicLayer = L.tileLayer("https://tile.openstreetmap.org/{z}/{x}/{y}.png", {
    maxZoom: 19,
    attribution: "&copy; OpenStreetMap contributors"
  });
  satelliteLayer.addTo(map);

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

  const locateBtn = document.getElementById("locate-btn");
  const baseMapBtn = document.getElementById("basemap-btn");
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

  const data = await getMapData();
  const blocks = data.blocks;
  const dwellings = data.dwellings;
  const specialLocations = data.specialLocations;
  const canPersistEdits = data.source === "api" || data.source === "cache";

  if (data.loadError) {
    setStatus(data.loadError, true);
  }

  const cuCodes = blocks.map((f) => extractCuCode(f.properties || {}));
  const colorMap = buildColorMap(cuCodes);
  const BLOCK_FILL_TRANSITION_ZOOM = 15;
  const BLOCK_FILL_FADE_ZOOM = 18;

  function blockFillOpacity(selected) {
    const zoom = map.getZoom();
    if (zoom >= BLOCK_FILL_FADE_ZOOM) return selected ? 0.14 : 0.07;
    if (zoom >= BLOCK_FILL_TRANSITION_ZOOM) return selected ? 0.24 : 0.16;
    return selected ? 0.38 : 0.24;
  }

  function styleForFeature(feature, selected) {
    const props = feature?.properties || {};
    const cu = extractCuCode(props);
    const color = colorMap.get(cu) || { stroke: "#15803d", fill: "#22c55e" };
    const isCu = getZoneKind(props) === "cu";
    return {
      color: color.stroke,
      fillColor: color.fill,
      fillOpacity: isCu ? (selected ? 0.18 : 0.08) : blockFillOpacity(selected),
      weight: selected ? 4 : (isCu ? 3 : 2),
      dashArray: isCu ? "8 6" : null,
      opacity: 0.95
    };
  }

  const editableLayer = L.featureGroup().addTo(map);
  const badgeLayer = L.layerGroup().addTo(map);
  const dwellingsLayer = L.layerGroup().addTo(map);
  const specialLocationsLayer = L.layerGroup().addTo(map);
  const dwellingClusterLayer = L.layerGroup().addTo(map);
  const blockLayers = [];
  const SPECIAL_LOCATIONS_MIN_VISIBLE_ZOOM = 10;

  async function showGeometryLinkForAdmin() {
    try {
      const me = await getJson("/api/me");
      if (geometryEditorLink && me?.user?.isAdmin) geometryEditorLink.hidden = false;
    } catch {
      // The server protects this route even if the UI check cannot be completed.
    }
  }
  void showGeometryLinkForAdmin();

  function setDwellingMovementEnabled(enabled) {
    dwellingMovementEnabled = Boolean(enabled);
    for (const marker of allDwellingMarkers) {
      marker.dragging?.[dwellingMovementEnabled ? "enable" : "disable"]();
    }
    for (const marker of allSpecialLocationMarkers) {
      marker.dragging?.[dwellingMovementEnabled ? "enable" : "disable"]();
    }
    dwellingMoveToggle?.classList.toggle("is-enabled", dwellingMovementEnabled);
    dwellingMoveToggle?.setAttribute("aria-pressed", String(dwellingMovementEnabled));
    if (dwellingMoveToggle) {
      dwellingMoveToggle.textContent = dwellingMovementEnabled ? "Lock movement" : "Unlock movement";
    }
    syncDwellingDisplay();
  }

  function dwellingClusterLabel(markers) {
    const numbers = markers
      .map((marker) => Number(extractDwellingNo(marker.feature?.properties || {})))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    if (numbers.length === 0) return String(markers.length);
    return numbers[0] === numbers[numbers.length - 1] ? String(numbers[0]) : `${numbers[0]}–${numbers[numbers.length - 1]}`;
  }

  function isCompletedDwellingCluster(markers) {
    const completedStatuses = new Set(["400", "402", "701", "312", "324"]);
    return markers.length > 0 && markers.every((marker) =>
      completedStatuses.has(normalizeDwellingStatus(marker.feature?.properties?.status))
    );
  }

  function splitConsecutiveDwellingMarkers(markers) {
    const ordered = [...markers].sort((a, b) => {
      const aNo = Number(extractDwellingNo(a.feature?.properties || {}));
      const bNo = Number(extractDwellingNo(b.feature?.properties || {}));
      return aNo - bNo;
    });
    return ordered.reduce((groups, marker) => {
      const lastGroup = groups[groups.length - 1];
      const previous = lastGroup?.[lastGroup.length - 1];
      const previousNo = Number(extractDwellingNo(previous?.feature?.properties || {}));
      const currentNo = Number(extractDwellingNo(marker.feature?.properties || {}));
      if (previous && currentNo === previousNo + 1) {
        lastGroup.push(marker);
      } else {
        groups.push([marker]);
      }
      return groups;
    }, []);
  }

  function syncDwellingDisplay() {
    if (!map || !dwellingClusterLayer) return;
    dwellingClusterLayer.clearLayers();
    const specialLocationsVisible = map.getZoom() >= SPECIAL_LOCATIONS_MIN_VISIBLE_ZOOM;
    for (const marker of allSpecialLocationMarkers) {
      marker.setOpacity(specialLocationsVisible ? 1 : 0);
      const element = marker.getElement?.();
      if (element) element.style.pointerEvents = specialLocationsVisible ? "" : "none";
    }
    const clusterMode = !dwellingMovementEnabled && map.getZoom() < 15;
    const buckets = new Map();
    for (const marker of allDwellingMarkers) {
      marker.setOpacity(clusterMode ? 0 : 1);
      const element = marker.getElement?.();
      if (element) element.style.pointerEvents = clusterMode ? "none" : "";
      if (!clusterMode) continue;
      const point = map.project(marker.getLatLng(), map.getZoom());
      const cu = extractCuCode(marker.feature?.properties || {});
      const key = `${cu}:${Math.floor(point.x / 72)}:${Math.floor(point.y / 72)}`;
      const bucket = buckets.get(key) || [];
      bucket.push(marker);
      buckets.set(key, bucket);
    }
    if (!clusterMode) return;
    for (const bucket of buckets.values()) {
      for (const markers of splitConsecutiveDwellingMarkers(bucket)) {
        if (markers.length < 2) {
          markers[0].setOpacity(1);
          const element = markers[0].getElement?.();
          if (element) element.style.pointerEvents = "";
          continue;
        }
        const bounds = L.latLngBounds(markers.map((marker) => marker.getLatLng()));
        const completed = isCompletedDwellingCluster(markers);
        L.marker(bounds.getCenter(), {
          icon: L.divIcon({
            className: "dwelling-cluster-wrap",
            html: `<span class="dwelling-cluster${completed ? " dwelling-cluster-completed" : ""}">${escapeHtml(dwellingClusterLabel(markers))}</span>`,
            iconAnchor: [35, 15]
          })
        }).on("click", () => map.fitBounds(bounds, { padding: [36, 36], maxZoom: 17 })).addTo(dwellingClusterLayer);
      }
    }
  }

  dwellingMoveToggle?.addEventListener("click", () => {
    setDwellingMovementEnabled(!dwellingMovementEnabled);
    setStatus(dwellingMovementEnabled ? "House and special-location movement unlocked. Dragging saves automatically." : "House and special-location movement locked.", false);
  });

  function updateDwellingSaveAllState() {
    if (!dwellingSaveAllBtn) return;
    dwellingSaveAllBtn.disabled = !canPersistEdits || dirtyDwellingMarkers.size === 0;
  }

  function markDwellingDirty(marker) {
    if (!marker) return;
    dirtyDwellingMarkers.add(marker);
    updateDwellingSaveAllState();
  }

  function clearDwellingDirty(marker) {
    if (!marker) return;
    dirtyDwellingMarkers.delete(marker);
    updateDwellingSaveAllState();
  }

  function selectZone(layer, options = {}) {
    const { showPopup = true, popupLatLng = null } = options;
    if (selectedPolygonLayer && selectedPolygonLayer !== layer) {
      selectedPolygonLayer.setStyle(styleForFeature(selectedPolygonLayer.feature, false));
    }
    selectedPolygonLayer = layer;
    selectedPolygonLayer.setStyle(styleForFeature(selectedPolygonLayer.feature, true));

    const props = layer.feature?.properties || {};
    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const zoneKind = getZoneKind(props) === "cu" ? "CU" : "Block";
    if (showPopup) {
      const details = block ? `${zoneKind}: ${block}` : zoneKind;
      const point = popupLatLng || getZoneCenter(layer);
      const shareTitle = block ? `Block ${cu}/${block}` : `CU ${cu}`;
      layer.bindPopup([
        `<div class="dw-popup">`,
        `<div class="dw-popup-code">${escapeHtml(shareTitle)}</div>`,
        `<div class="dw-popup-meta">CU: ${escapeHtml(cu)}<br>${escapeHtml(details)}</div>`,
        buildMapActionButtons(point.lat, point.lng, shareTitle),
        `</div>`
      ].join(""), { autoPan: false });
      layer.once("popupopen", (event) => attachMapActionHandlers(event?.popup?.getElement?.()));
      if (popupLatLng) {
        layer.openPopup(popupLatLng);
      } else {
        layer.openPopup();
      }
    }

    if (dwellingFields.cu && !isNonEmpty(dwellingFields.cu.value)) dwellingFields.cu.value = cu;
    if (dwellingFields.block && !isNonEmpty(dwellingFields.block.value) && block) dwellingFields.block.value = block;
  }

  function findZoneLayerByLatLng(latlng) {
    let foundCu = null;
    let foundBlock = null;
    editableLayer.eachLayer((layer) => {
      if (foundBlock) return;
      if (featureContainsLatLng(layer.feature, latlng)) {
        if (getZoneKind(layer.feature?.properties || {}) === "block") {
          foundBlock = layer;
          return;
        }
        foundCu = layer;
      }
    });
    return foundBlock || foundCu;
  }

  function resolveZoneForDwellingAdd(latlng) {
    for (const layer of blockLayers) {
      if (featureContainsLatLng(layer.feature, latlng)) return layer;
    }
    const directZone = findZoneLayerByLatLng(latlng);
    if (directZone && getZoneKind(directZone.feature?.properties || {}) === "block") return directZone;
    if (selectedPolygonLayer && getZoneKind(selectedPolygonLayer.feature?.properties || {}) === "block") {
      return selectedPolygonLayer;
    }
    return null;
  }

  function rebuildBadges() {
    badgeLayer.clearLayers();
    const currentZoom = map.getZoom();
    if (currentZoom <= 12 || currentZoom >= 16) return;
    editableLayer.eachLayer((layer) => {
      const props = layer.feature?.properties || {};
      const zoneKind = getZoneKind(props);
      if (zoneKind !== "block") return;
      const cu = extractCuCode(props);
      const code = extractBlockCode(props);
      const center = getZoneCenter(layer);
      const icon = L.divIcon({
        className: "zone-chip-wrap",
        html: `<span class="zone-chip"><span class="block-badge">${code}</span><span class="zone-chip-text">${cu}</span></span>`,
        iconAnchor: [12, 12]
      });
      L.marker(center, { icon, interactive: false }).addTo(badgeLayer);
    });
  }

  function addFeatureLayer(feature) {
    const geo = L.geoJSON(feature, {
      renderer: vectorRenderer,
      style: () => styleForFeature(feature, false)
    });

    geo.eachLayer((layer) => {
      layer.feature = {
        type: "Feature",
        id: feature.id,
        properties: { ...(feature.properties || {}) },
        geometry: feature.geometry
      };
      layer.on("click", (event) => {
        const src = event?.originalEvent;
        const isAddIntent = Boolean(src && (src.ctrlKey || src.metaKey || src.button === 2));
        if (isAddIntent) {
          src.preventDefault?.();
          src.stopPropagation?.();
          void addDwellingAt(event.latlng, layer);
          return;
        }
        selectZone(layer, { showPopup: true, popupLatLng: event?.latlng || null });
      });
      layer.on("contextmenu", (event) => {
        const src = event?.originalEvent;
        src?.preventDefault?.();
        src?.stopPropagation?.();
        void addDwellingAt(event.latlng, layer);
      });
      layer.on("tap", (event) => selectZone(layer, { showPopup: true, popupLatLng: event?.latlng || null }));
      editableLayer.addLayer(layer);
      if (getZoneKind(layer.feature?.properties || {}) === "block") {
        blockLayers.push(layer);
      }
    });
  }

  function dwellingMarkerIcon(no, status, selected) {
    return L.divIcon({
      className: "dwelling-marker-wrap",
      html: `<span class="dwelling-marker dwelling-status-${normalizeDwellingStatus(status)} ${selected ? "selected" : ""}">${String(no)}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  const SPECIAL_LOCATION_ICONS = {
    band_hall: "band_hall.svg", stadium: "stadium.svg", cafe: "local_cafe.svg", gas_station: "gas_station.svg",
    arena: "stadium.svg", cultural: "cultural.svg", church: "church.svg", band_office: "band_office.svg",
    health_office: "health_office.svg", radio_tower: "radio_tower.svg", school: "school.svg", other: "other.svg"
  };

  function specialLocationIcon(type, selected = false) {
    const asset = SPECIAL_LOCATION_ICONS[type] || SPECIAL_LOCATION_ICONS.other;
    return L.divIcon({
      className: "special-location-marker-wrap",
      html: `<span class="special-location-marker${selected ? " selected" : ""}"><img src="/place-icons/${asset}" alt=""></span>`,
      iconSize: [30, 30], iconAnchor: [15, 15]
    });
  }

  function applySpecialLocationMarkerIcon(marker, selected) {
    const type = String(marker?.feature?.properties?.locationType || "other").trim();
    marker?.setIcon?.(specialLocationIcon(type, selected));
  }

  function clearSelectedSpecialLocation() {
    if (!selectedSpecialLocationMarker) return;
    applySpecialLocationMarkerIcon(selectedSpecialLocationMarker, false);
    selectedSpecialLocationMarker = null;
  }

  function selectSpecialLocationMarker(marker) {
    if (!marker) return;
    if (selectedDwellingMarker) {
      applyMarkerIcon(selectedDwellingMarker, false);
      selectedDwellingMarker = null;
    }
    if (selectedSpecialLocationMarker && selectedSpecialLocationMarker !== marker) {
      applySpecialLocationMarkerIcon(selectedSpecialLocationMarker, false);
    }
    selectedSpecialLocationMarker = marker;
    applySpecialLocationMarkerIcon(marker, true);
    if (specialLocationGroup) specialLocationGroup.open = true;
    const props = marker.feature?.properties || {};
    specialLocationTypeInput.value = String(props.locationType || "other");
    specialLocationNameInput.value = String(props.name || props.label || "");
    specialLocationNotesInput.value = String(props.notes || "");
    setStatus(`${specialLocationNameInput.value || "Special location"} selected`, false);
  }

  function buildSpecialLocationPopupHtml(feature) {
    const props = feature?.properties || {};
    const coordinates = feature?.geometry?.coordinates || [];
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    const name = String(props.name || props.label || "Special location").trim();
    const type = String(props.locationType || "other").trim();
    const notes = String(props.notes || "").trim();
    return [
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(name)}</div>`,
      `<div class="dw-popup-meta">${escapeHtml(type.replaceAll("_", " "))}</div>`,
      notes ? `<div class="dw-popup-notes"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : "",
      buildMapActionButtons(lat, lng, name),
      `</div>`
    ].join("");
  }

  function attachSpecialLocationPopupHandlers(marker) {
    marker.bindPopup(buildSpecialLocationPopupHtml(marker.feature), { autoPan: true });
    marker.off("popupopen");
    marker.on("popupopen", (event) => {
      attachMapActionHandlers(event?.popup?.getElement?.());
    });
  }

  function createSpecialLocationMarker(feature) {
    const coordinates = feature?.geometry?.coordinates || [];
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const marker = L.marker([lat, lng], { icon: specialLocationIcon(feature?.properties?.locationType), keyboard: true, draggable: dwellingMovementEnabled }).addTo(specialLocationsLayer);
    marker.feature = {
      type: "Feature",
      id: feature.id ?? null,
      properties: { ...(feature.properties || {}) },
      geometry: { type: "Point", coordinates: [lng, lat] }
    };
    allSpecialLocationMarkers.add(marker);
    marker.on("click", () => selectSpecialLocationMarker(marker));
    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      marker.feature.geometry = { type: "Point", coordinates: [Number(ll.lng), Number(ll.lat)] };
      attachSpecialLocationPopupHandlers(marker);
      setSyncStatus("Sending…", "pending");
      setStatus("Special-location position changed; saving automatically.", false);
      void persistSpecialLocationMarker(marker, { useMarkerProperties: true });
    });
    attachSpecialLocationPopupHandlers(marker);
    const id = getFeatureId(feature);
    if (id !== null) specialLocationMarkersById.set(id, marker);
    return marker;
  }

  async function placeSpecialLocation(latlng) {
    const type = String(specialLocationTypeInput?.value || "other");
    const name = String(specialLocationNameInput?.value || "").trim() || type.replaceAll("_", " ");
    const notes = String(specialLocationNotesInput?.value || "").trim();
    const feature = {
      type: "Feature",
      properties: { _group: "special_locations", locationType: type, name, label: name, notes },
      geometry: { type: "Point", coordinates: [Number(latlng.lng), Number(latlng.lat)] }
    };
    try {
      setSyncStatus("Sending…", "pending");
      const created = await getJson(`/api/cld/${cld}/features`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feature)
      });
      const id = Number(created.ids?.[0]);
      if (Number.isFinite(id)) feature.id = id;
      const marker = createSpecialLocationMarker(feature);
      selectSpecialLocationMarker(marker);
      specialLocationPlacementPending = false;
      specialLocationPlaceBtn.textContent = "New";
      setSyncStatus("Saved", "saved");
      setStatus(`${name} added.`, false);
    } catch (error) {
      setSyncStatus("Save failed", "error");
      setStatus(`Could not add special location: ${error.message}`, true);
    }
  }

  specialLocationPlaceBtn?.addEventListener("click", () => {
    if (selectedDwellingMarker) {
      applyMarkerIcon(selectedDwellingMarker, false);
      selectedDwellingMarker = null;
    }
    clearSelectedSpecialLocation();
    if (specialLocationGroup) specialLocationGroup.open = true;
    specialLocationPlacementPending = !specialLocationPlacementPending;
    specialLocationPlaceBtn.textContent = specialLocationPlacementPending ? "Tap Map to Place" : "New";
    setStatus(specialLocationPlacementPending ? "Tap the map to place this special location." : "Special location placement cancelled.", false);
  });

  function specialLocationFeatureFromForm(existingId, latlng, originalProperties = {}) {
    const type = String(specialLocationTypeInput?.value || "other").trim();
    const name = String(specialLocationNameInput?.value || "").trim() || type.replaceAll("_", " ");
    return {
      type: "Feature",
      ...(existingId !== null ? { id: existingId } : {}),
      properties: {
        ...(originalProperties || {}),
        _group: "special_locations",
        locationType: type,
        name,
        label: name,
        notes: String(specialLocationNotesInput?.value || "").trim()
      },
      geometry: { type: "Point", coordinates: [Number(latlng.lng), Number(latlng.lat)] }
    };
  }

  function specialLocationFeatureFromMarkerProperties(existingId, latlng, originalProperties = {}) {
    const props = { ...(originalProperties || {}) };
    const type = String(props.locationType || "other").trim();
    const name = String(props.name || props.label || type.replaceAll("_", " ")).trim();
    return {
      type: "Feature",
      ...(existingId !== null ? { id: existingId } : {}),
      properties: { ...props, _group: "special_locations", locationType: type, name, label: String(props.label || name).trim() },
      geometry: { type: "Point", coordinates: [Number(latlng.lng), Number(latlng.lat)] }
    };
  }

  async function persistSpecialLocationMarker(marker, { useMarkerProperties = false } = {}) {
    if (!canPersistEdits) {
      setStatus("Cannot save special location: API source unavailable.", true);
      return false;
    }
    if (!marker) {
      setStatus("Select a special location first, or press New.", true);
      return false;
    }
    const id = getFeatureId(marker.feature);
    const payload = useMarkerProperties
      ? specialLocationFeatureFromMarkerProperties(id, marker.getLatLng(), marker.feature?.properties)
      : specialLocationFeatureFromForm(id, marker.getLatLng(), marker.feature?.properties);
    try {
      setSyncStatus("Sending…", "pending");
      if (id === null) {
        const created = await getJson(`/api/cld/${cld}/features`, {
          method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
        const createdId = Number(created.ids?.[0]);
        if (!Number.isFinite(createdId)) throw new Error("Create did not return new id");
        payload.id = createdId;
        specialLocationMarkersById.set(createdId, marker);
      } else {
        await getJson(`/api/cld/${cld}/features/${id}`, {
          method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload)
        });
      }
      marker.feature = payload;
      applySpecialLocationMarkerIcon(marker, marker === selectedSpecialLocationMarker);
      attachSpecialLocationPopupHandlers(marker);
      setSyncStatus("Saved", "saved");
      setStatus(`${payload.properties.name} saved`, false);
      return true;
    } catch (error) {
      setSyncStatus("Save failed", "error");
      setStatus(`Special-location save failed: ${error.message}`, true);
      return false;
    }
  }

  function removeSpecialLocationMarkerLocally(marker) {
    if (!marker) return;
    const id = getFeatureId(marker.feature);
    if (selectedSpecialLocationMarker === marker) {
      selectedSpecialLocationMarker = null;
      specialLocationNameInput.value = "";
      specialLocationNotesInput.value = "";
      specialLocationTypeInput.value = "other";
    }
    specialLocationsLayer.removeLayer(marker);
    allSpecialLocationMarkers.delete(marker);
    if (id !== null) specialLocationMarkersById.delete(id);
  }

  specialLocationSaveBtn?.addEventListener("click", () => {
    void persistSpecialLocationMarker(selectedSpecialLocationMarker);
  });

  specialLocationDeleteBtn?.addEventListener("click", async () => {
    const marker = selectedSpecialLocationMarker;
    if (!marker) {
      setStatus("Select a special location to delete.", true);
      return;
    }
    const id = getFeatureId(marker.feature);
    if (id === null) {
      removeSpecialLocationMarkerLocally(marker);
      setStatus("Unsaved special location removed", false);
      return;
    }
    if (!canPersistEdits) {
      setStatus("Cannot delete special location: API source unavailable.", true);
      return;
    }
    try {
      await getJson(`/api/cld/${cld}/features/${id}`, { method: "DELETE" });
      removeSpecialLocationMarkerLocally(marker);
      setStatus("Special location deleted", false);
    } catch (error) {
      setStatus(`Special-location delete failed: ${error.message}`, true);
    }
  });

  function buildDwellingPopupHtml(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry || {};
    const lat = Number(geom?.coordinates?.[1]);
    const lng = Number(geom?.coordinates?.[0]);
    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const displayNo = displayDwellingNo(props);
    const code = `${cu}${extractDwellingNo(props)}`;
    const notes = String(props.notes || "").trim();
    const currentStatus = normalizeDwellingStatus(props.status);
    const statusOptions = [...DWELLING_STATUSES]
      .map((status) => `<option value="${status}"${status === currentStatus ? " selected" : ""}>${status}</option>`)
      .join("");
    return [
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(code)}</div>`,
      `<div class="dw-popup-meta">CU ${escapeHtml(cu)} · Block ${escapeHtml(block)} · Dwelling ${escapeHtml(displayNo)}</div>`,
      notes ? `<div class="dw-popup-notes"><strong>Notes:</strong> ${escapeHtml(notes)}</div>` : "",
      `<div class="dw-popup-status-row">`,
      `<label class="dw-popup-status">Status <select class="dw-status-select">${statusOptions}</select></label>`,
      buildMapActionButtons(lat, lng, `Dwelling ${code}`, true),
      `</div>`,
      `</div>`
    ].join("");
  }

  function attachDwellingPopupHandlers(marker) {
    marker.bindPopup(buildDwellingPopupHtml(marker.feature), { autoPan: true });
    marker.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
      attachMapActionHandlers(root);

      const statusSelect = root?.querySelector(".dw-status-select");
      statusSelect?.addEventListener("change", async () => {
        const previousStatus = normalizeDwellingStatus(marker.feature?.properties?.status);
        const nextStatus = normalizeDwellingStatus(statusSelect.value);
        if (nextStatus === previousStatus) return;
        statusSelect.disabled = true;
        marker.feature.properties.status = nextStatus;
        applyMarkerIcon(marker, marker === selectedDwellingMarker);
        if (marker === selectedDwellingMarker && dwellingFields.status) {
          dwellingFields.status.value = nextStatus;
        }
        markDwellingDirty(marker);
        const saved = await persistDwellingMarker(marker, {
          selectAfterSave: marker === selectedDwellingMarker,
          useMarkerProperties: true
        });
        if (!saved) {
          marker.feature.properties.status = previousStatus;
          statusSelect.value = previousStatus;
          applyMarkerIcon(marker, marker === selectedDwellingMarker);
          if (marker === selectedDwellingMarker && dwellingFields.status) {
            dwellingFields.status.value = previousStatus;
          }
        }
        statusSelect.disabled = false;
      });
    });
  }

  function markerFeature(marker) {
    return marker?.feature || null;
  }

  function applyMarkerIcon(marker, selected) {
    const feature = markerFeature(marker);
    if (!feature) return;
    const no = displayDwellingNo(feature.properties || {});
    marker.setIcon(dwellingMarkerIcon(no, feature.properties?.status, selected));
  }

  function removeDwellingMarkerLocally(marker) {
    if (!marker) return;
    const id = getFeatureId(marker.feature);
    if (selectedDwellingMarker === marker) {
      selectedDwellingMarker = null;
      clearDwellingForm();
    }
    clearDwellingDirty(marker);
    dwellingsLayer.removeLayer(marker);
    allDwellingMarkers.delete(marker);
    if (id !== null) dwellingMarkersById.delete(id);

  }

  function fillFormFromFeature(feature) {
    const props = feature?.properties || {};
    dwellingFields.cu.value = extractCuCode(props);
    dwellingFields.block.value = extractBlockCode(props);
    dwellingFields.no.value = extractDwellingNo(props);
    dwellingFields.status.value = normalizeDwellingStatus(props.status);
    dwellingFields.notes.value = props.notes || "";
  }

  function featureFromForm(existingId, latlng) {
    const cu = String(dwellingFields.cu.value || "").trim();
    const block = String(dwellingFields.block.value || "").trim().padStart(2, "0");
    const dwellingNo = formatDwellingNo(dwellingFields.no.value || "");
    if (!isNonEmpty(cu)) throw new Error("CU is required");
    if (!/^[0-9]{2}$/.test(block)) throw new Error("Block must be 2 digits");
    if (!/^[0-9]{4}$/.test(dwellingNo)) throw new Error("Dwelling No must be 4 digits");

    const properties = {
      _group: "dwellings",
      CUID: cu,
      CB_COLCODE: block,
      dwellingNo,
      notes: String(dwellingFields.notes.value || "").trim(),
      status: normalizeDwellingStatus(dwellingFields.status.value),
      photos: Array.isArray(selectedDwellingMarker?.feature?.properties?.photos)
        ? [...selectedDwellingMarker.feature.properties.photos]
        : [],
      name: `${cu} / ${block} / ${dwellingNo}`,
      label: `${dwellingNo}`
    };

    return {
      type: "Feature",
      ...(existingId !== null ? { id: existingId } : {}),
      properties,
      geometry: {
        type: "Point",
        coordinates: [Number(latlng.lng), Number(latlng.lat)]
      }
    };
  }

  function featureFromMarkerProperties(existingId, latlng, baseProperties) {
    const original = baseProperties && typeof baseProperties === "object" ? baseProperties : {};
    const {
      dwellingType, type, civicNo, civic, contact, externalLink, photo, description, occupied,
      ...supportedProperties
    } = original;
    const cu = String(original.CUID ?? original.cu ?? "").trim();
    const block = String(original.CB_COLCODE ?? original.block ?? "").trim().padStart(2, "0");
    const dwellingNo = formatDwellingNo(original.dwellingNo ?? original.DWELLING_NO ?? original.vrNumber ?? original.VR_NUMBER ?? "");
    if (!isNonEmpty(cu)) throw new Error("CU is required");
    if (!/^[0-9]{2}$/.test(block)) throw new Error("Block must be 2 digits");
    if (!/^[0-9]{4}$/.test(dwellingNo)) throw new Error("Dwelling No must be 4 digits");

    const properties = {
      ...supportedProperties,
      _group: "dwellings",
      CUID: cu,
      CB_COLCODE: block,
      dwellingNo,
      notes: String(original.notes ?? "").trim(),
      status: normalizeDwellingStatus(original.status),
      name: String(original.name ?? `${cu} / ${block} / ${dwellingNo}`).trim(),
      label: String(original.label ?? dwellingNo).trim()
    };

    return {
      type: "Feature",
      ...(existingId !== null ? { id: existingId } : {}),
      properties,
      geometry: {
        type: "Point",
        coordinates: [Number(latlng.lng), Number(latlng.lat)]
      }
    };
  }

  function nextDwellingNoForCu(cuCode) {
    let maxNo = 0;
    dwellingsLayer.eachLayer((marker) => {
      const props = marker.feature?.properties || {};
      if (extractCuCode(props) !== cuCode) return;
      const no = Number(extractDwellingNo(props));
      if (Number.isFinite(no) && no > maxNo) maxNo = no;
    });
    return String(maxNo + 1).padStart(4, "0");
  }

  function findDwellingDuplicateInCu(cuCode, dwellingNo, excludeMarker) {
    let duplicate = null;
    dwellingsLayer.eachLayer((marker) => {
      if (duplicate) return;
      if (marker === excludeMarker) return;
      const props = marker.feature?.properties || {};
      if (extractCuCode(props) !== cuCode) return;
      if (extractDwellingNo(props) !== dwellingNo) return;
      duplicate = {
        marker,
        id: getFeatureId(marker.feature)
      };
    });
    return duplicate;
  }

  function createDwellingMarker(feature, { temporary = false } = {}) {
    const geom = feature?.geometry || {};
    if (geom.type !== "Point" || !Array.isArray(geom.coordinates)) return null;
    const lat = Number(geom.coordinates[1]);
    const lng = Number(geom.coordinates[0]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const marker = L.marker([lat, lng], {
      icon: dwellingMarkerIcon(displayDwellingNo(feature.properties || {}), feature.properties?.status, false),
      draggable: false,
      bubblingMouseEvents: true
    }).addTo(dwellingsLayer);
    marker.feature = {
      type: "Feature",
      id: feature.id ?? null,
      properties: { ...(feature.properties || {}) },
      geometry: {
        type: "Point",
        coordinates: [lng, lat]
      }
    };
    marker._temporary = temporary;
    allDwellingMarkers.add(marker);
    if (temporary) {
      markDwellingDirty(marker);
    }

    marker.on("click", () => {
      clearSelectedSpecialLocation();
      if (selectedDwellingMarker && selectedDwellingMarker !== marker) {
        applyMarkerIcon(selectedDwellingMarker, false);
      }
      selectedDwellingMarker = marker;
      applyMarkerIcon(marker, true);
      fillFormFromFeature(marker.feature);
      setStatus(`Dwelling ${displayDwellingNo(marker.feature.properties || {})} selected`, false);
    });
    attachDwellingPopupHandlers(marker);

    marker.on("dragend", () => {
      const ll = marker.getLatLng();
      marker.feature.geometry = { type: "Point", coordinates: [Number(ll.lng), Number(ll.lat)] };
      markDwellingDirty(marker);
      attachDwellingPopupHandlers(marker);
      setSyncStatus("Sending…", "pending");
      setStatus("House position changed; saving automatically.", false);
      void persistDwellingMarker(marker, { selectAfterSave: selectedDwellingMarker === marker, useMarkerProperties: true });
    });

    const markerId = getFeatureId(marker.feature);
    if (markerId !== null) {
      dwellingMarkersById.set(markerId, marker);
    }

    return marker;
  }

  for (const feature of blocks) {
    addFeatureLayer(feature);
  }
  rebuildBadges();
  badgesReady = true;

  function redrawEditableZones() {
    editableLayer.eachLayer((layer) => {
      layer.setStyle?.(styleForFeature(layer.feature, layer === selectedPolygonLayer));
      layer.redraw?.();
    });
    if (badgesReady) rebuildBadges();
  }
  map.on("zoomend", redrawEditableZones);
  map.on("moveend", redrawEditableZones);
  map.on("viewreset", redrawEditableZones);
  map.on("zoomend moveend", syncDwellingDisplay);

  for (const feature of dwellings) {
    createDwellingMarker(feature);
  }
  for (const feature of specialLocations) {
    createSpecialLocationMarker(feature);
  }
  setDwellingMovementEnabled(false);
  updateDwellingSaveAllState();

  if (editableLayer.getLayers().length > 0) {
    map.fitBounds(editableLayer.getBounds(), { padding: [20, 20] });
  } else if (dwellingsLayer.getLayers().length > 0) {
    const dwellingBounds = dwellingsLayer.getBounds();
    if (dwellingBounds.isValid()) {
      map.fitBounds(dwellingBounds, { padding: [20, 20] });
    }
  } else {
    setStatus(
      `No region geometry loaded for CLD ${cld}.`,
      true
    );
  }
  applyRequestedMapView();

  function clearDwellingForm() {
    dwellingFields.cu.value = "";
    dwellingFields.block.value = "";
    dwellingFields.no.value = "";
    dwellingFields.status.value = "429";
    dwellingFields.notes.value = "";
  }

  const offlineQueueKey = `cld-map-pending:${cld}`;

  function readOfflineQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
      return Array.isArray(queue) ? queue : [];
    } catch {
      return [];
    }
  }

  function queueMutation(method, url, payload) {
    const queue = readOfflineQueue();
    const existing = queue.findIndex((item) => item.method === method && item.url === url);
    const item = { method, url, payload, queuedAt: Date.now() };
    if (existing >= 0 && method === "PUT") queue.splice(existing, 1, item);
    else queue.push(item);
    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
    setSyncStatus("Waiting to send", "pending");
  }

  async function flushOfflineQueue() {
    if (!navigator.onLine) return;
    const queue = readOfflineQueue();
    if (queue.length === 0) return;
    setSyncStatus(`Sending ${queue.length} change${queue.length === 1 ? "" : "s"}…`, "pending");
    const remaining = [];
    for (const item of queue) {
      try {
        await getJson(item.url, {
          method: item.method,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(item.payload)
        });
      } catch {
        remaining.push(item);
      }
    }
    localStorage.setItem(offlineQueueKey, JSON.stringify(remaining));
    setSyncStatus(remaining.length ? "Waiting to send" : "Saved", remaining.length ? "pending" : "saved");
  }

  async function refreshMapChanges() {
    if (!navigator.onLine) return;
    try {
      const data = await getJson(`/api/cld/${cld}/features`);
      const features = (data.features || []).filter((feature) => !isExcludedCuFeature(feature));
      localStorage.setItem(`cld-map-cache:${cld}`, JSON.stringify({ savedAt: Date.now(), features }));
      let added = 0;
      let addedSpecialLocations = 0;
      for (const feature of features) {
        if (isSpecialLocationFeature(feature.properties || {}, feature.geometry || {})) {
          const id = getFeatureId(feature);
          if (id !== null && specialLocationMarkersById.has(id)) continue;
          if (createSpecialLocationMarker(feature)) addedSpecialLocations += 1;
          continue;
        }
        if (!isDwellingFeature(feature.properties || {}, feature.geometry || {})) continue;
        const id = getFeatureId(feature);
        if (id !== null && dwellingMarkersById.has(id)) continue;
        if (createDwellingMarker(feature)) added += 1;
      }
      if (added > 0 || addedSpecialLocations > 0) {
        syncDwellingDisplay();
        const messages = [];
        if (added) messages.push(`${added} new house${added === 1 ? "" : "s"}`);
        if (addedSpecialLocations) messages.push(`${addedSpecialLocations} special location${addedSpecialLocations === 1 ? "" : "s"}`);
        setStatus(`${messages.join(" and ")} added from the map.`, false);
      }
    } catch {
      // Keep the current map and retry at the next interval.
    }
  }

  window.addEventListener("online", () => {
    void flushOfflineQueue();
    void refreshMapChanges();
  });
  void flushOfflineQueue();
  window.setInterval(() => {
    void flushOfflineQueue();
    void refreshMapChanges();
  }, 120000);

  function buildNewDwellingFeature(extraProperties = {}, preferredLatLng = null) {
    if (selectedDwellingMarker) {
      applyMarkerIcon(selectedDwellingMarker, false);
      selectedDwellingMarker = null;
    }

    const ctxCu = selectedPolygonLayer ? extractCuCode(selectedPolygonLayer.feature?.properties || {}) : (cuCodes[0] || "46221114");
    const selectedBlock = selectedPolygonLayer ? extractBlockCode(selectedPolygonLayer.feature?.properties || {}) : "";
    const ctxBlock = selectedBlock || "01";
    const point = preferredLatLng || (selectedPolygonLayer ? getZoneCenter(selectedPolygonLayer) : map.getCenter());

    return {
      type: "Feature",
      id: null,
      properties: {
        _group: "dwellings",
        CUID: ctxCu,
        CB_COLCODE: ctxBlock,
        dwellingNo: nextDwellingNoForCu(ctxCu),
        notes: "",
        status: "429",
        photos: [],
        label: "",
        ...extraProperties
      },
      geometry: { type: "Point", coordinates: [point.lng, point.lat] }
    };
  }

  function createNewDwellingDraft(extraProperties = {}, preferredLatLng = null) {
    const feature = buildNewDwellingFeature(extraProperties, preferredLatLng);

    const marker = createDwellingMarker(feature, { temporary: true });
    if (!marker) {
      setStatus("Failed to create dwelling marker", true);
      return null;
    }
    selectedDwellingMarker = marker;
    applyMarkerIcon(marker, true);
    fillFormFromFeature(feature);
    return marker;
  }

  dwellingNewBtn?.addEventListener("click", () => {
    const marker = createNewDwellingDraft();
    if (marker) {
      setStatus("New dwelling created. Fill fields and press Save.", false);
    }
  });

  async function persistDwellingMarker(marker, { selectAfterSave = true, useMarkerProperties = false } = {}) {
    if (!canPersistEdits) {
      setStatus("Cannot save dwelling: API source unavailable.", true);
      return false;
    }

    if (!marker) {
      setStatus("Select dwelling marker first, or press New.", true);
      return false;
    }

    const id = getFeatureId(marker.feature);
    const latlng = marker.getLatLng();

    let payload;
    try {
      payload = useMarkerProperties
        ? featureFromMarkerProperties(id, latlng, marker.feature?.properties || {})
        : featureFromForm(id, latlng);
    } catch (error) {
      setStatus(error.message, true);
      return false;
    }

    const payloadProps = payload?.properties || {};
    const cuCode = extractCuCode(payloadProps);
    const dwellingNo = extractDwellingNo(payloadProps);
    const duplicate = findDwellingDuplicateInCu(cuCode, dwellingNo, marker);
    if (duplicate) {
      const conflictHint = duplicate.id !== null ? ` (feature id ${duplicate.id})` : "";
      setStatus(`Dwelling ${dwellingNo} already exists in CU ${cuCode}${conflictHint}`, true);
      return false;
    }

    try {
      setSyncStatus("Sending…", "pending");
      if (id === null) {
        const createRes = await getJson(`/api/cld/${cld}/features`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        const createdId = Array.isArray(createRes.ids) ? Number(createRes.ids[0]) : null;
        if (!Number.isFinite(createdId)) throw new Error("Create did not return new id");
        payload.id = createdId;
        marker.feature = payload;
        marker._temporary = false;
        dwellingMarkersById.set(createdId, marker);
      } else {
        await getJson(`/api/cld/${cld}/features/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });
        marker.feature = payload;
      }

      if (selectAfterSave) {
        selectedDwellingMarker = marker;
        applyMarkerIcon(marker, true);
      } else {
        applyMarkerIcon(marker, false);
      }
      clearDwellingDirty(marker);
      setSyncStatus("Saved", "saved");
      setStatus(`Dwelling ${extractDwellingNo(payload.properties || {})} saved`, false);
      return true;
    } catch (error) {
      if (!navigator.onLine || error instanceof TypeError) {
        const url = id === null ? `/api/cld/${cld}/features` : `/api/cld/${cld}/features/${id}`;
        queueMutation(id === null ? "POST" : "PUT", url, payload);
        setStatus("Saved on this device; it will be sent when the connection returns.", false);
        return true;
      }
      setSyncStatus("Save failed", "error");
      setStatus(`Dwelling save failed: ${error.message}`, true);
      return false;
    }
  }

  dwellingSaveBtn?.addEventListener("click", async () => {
    await persistDwellingMarker(selectedDwellingMarker, { selectAfterSave: true });
  });

  for (const field of Object.values(dwellingFields)) {
    if (!field) continue;
    const eventName = field.type === "checkbox" ? "change" : "input";
    field.addEventListener(eventName, () => {
      if (!selectedDwellingMarker) return;
      if (field === dwellingFields.status) {
        const no = displayDwellingNo(selectedDwellingMarker.feature?.properties || {});
        selectedDwellingMarker.setIcon(dwellingMarkerIcon(no, field.value, true));
        setStatus("Saving status...", false);
        markDwellingDirty(selectedDwellingMarker);
        void persistDwellingMarker(selectedDwellingMarker, { selectAfterSave: true });
        return;
      }
      markDwellingDirty(selectedDwellingMarker);
      setStatus("Dwelling fields changed. Press Save or Save All.", false);
    });
  }

  function getDwellingBulkRows() {
    return [...allDwellingMarkers]
      .filter((marker) => dwellingsLayer.hasLayer(marker))
      .map((marker) => {
        const props = marker.feature?.properties || {};
        const latlng = marker.getLatLng();
        return {
          ssid: `${extractCuCode(props)}${extractDwellingNo(props)}`,
          coordinate: `${Number(latlng.lng).toFixed(6)}, ${Number(latlng.lat).toFixed(6)}`,
          status: normalizeDwellingStatus(props.status)
        };
      })
      .sort((a, b) => a.ssid.localeCompare(b.ssid));
  }

  function exportDwellingsXls() {
    const rows = getDwellingBulkRows();
    const cells = (value) => escapeHtml(value);
    const tableRows = rows.map((row) =>
      `<tr><td style="mso-number-format:'\\@';">${cells(row.ssid)}</td><td>${cells(row.coordinate)}</td><td>${cells(row.status)}</td></tr>`
    ).join("");
    const workbook = `<!doctype html><html><head><meta charset="utf-8"></head><body><table><tr><th>SSID</th><th>Coordinate</th><th>Status</th></tr>${tableRows}</table></body></html>`;
    const blob = new Blob([workbook], { type: "application/vnd.ms-excel;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `cld-${cld}-dwellings.xls`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
    setStatus(`Exported ${rows.length} dwelling(s).`, false);
  }

  async function copyOpenedSsids() {
    const ssids = getDwellingBulkRows()
      .filter((row) => row.status === "429")
      .map((row) => row.ssid)
      .join("\n");
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(ssids);
      } else {
        const fallback = document.createElement("textarea");
        fallback.value = ssids;
        document.body.appendChild(fallback);
        fallback.select();
        document.execCommand("copy");
        fallback.remove();
      }
      setStatus(`${ssids ? ssids.split("\n").length : 0} opened SSID(s) copied.`, false);
    } catch (error) {
      setStatus(`Could not copy opened SSIDs: ${error.message}`, true);
    }
  }

  dwellingExportBtn?.addEventListener("click", exportDwellingsXls);
  copyOpenedSsidsBtn?.addEventListener("click", () => {
    void copyOpenedSsids();
  });

  async function applyBulkStatusChange() {
    const requestedSsids = new Set(
      String(bulkStatusSsidsInput?.value || "")
        .split(/\r?\n/)
        .map((value) => value.replace(/\D/g, ""))
        .filter(Boolean)
    );
    const nextStatus = normalizeDwellingStatus(bulkStatusCodeInput?.value);
    if (requestedSsids.size === 0) {
      setStatus("Paste one SSID per line first.", true);
      return;
    }

    const markersBySsid = new Map(
      [...allDwellingMarkers].map((marker) => {
        const props = marker.feature?.properties || {};
        return [`${extractCuCode(props)}${extractDwellingNo(props)}`, marker];
      })
    );
    const markers = [];
    const missing = [];
    for (const ssid of requestedSsids) {
      const marker = markersBySsid.get(ssid);
      if (marker) markers.push(marker);
      else missing.push(ssid);
    }
    if (markers.length === 0) {
      setStatus("No SSIDs from the list were found in this CLD.", true);
      return;
    }

    bulkStatusApplyBtn.disabled = true;
    setStatus(`Applying status ${nextStatus} to ${markers.length} dwelling(s)…`, false);
    let saved = 0;
    let failed = 0;
    for (const marker of markers) {
      marker.feature.properties.status = nextStatus;
      applyMarkerIcon(marker, marker === selectedDwellingMarker);
      markDwellingDirty(marker);
      const didSave = await persistDwellingMarker(marker, {
        selectAfterSave: marker === selectedDwellingMarker,
        useMarkerProperties: true
      });
      if (didSave) saved += 1;
      else failed += 1;
    }
    bulkStatusApplyBtn.disabled = false;
    if (failed > 0) {
      setStatus(`Bulk status finished: ${saved} saved, ${failed} failed${missing.length ? `, ${missing.length} SSID(s) not found` : ""}.`, true);
      return;
    }
    setStatus(`Bulk status saved for ${saved} dwelling(s)${missing.length ? `; ${missing.length} SSID(s) not found` : ""}.`, false);
  }

  bulkStatusApplyBtn?.addEventListener("click", () => {
    void applyBulkStatusChange();
  });

  async function saveAllDirtyDwellings() {
    if (!canPersistEdits) {
      setStatus("Cannot save dwellings: API source unavailable.", true);
      return;
    }
    const markers = [...dirtyDwellingMarkers].filter((marker) => dwellingsLayer.hasLayer(marker));
    if (markers.length === 0) {
      setStatus("No pending dwelling changes.", false);
      updateDwellingSaveAllState();
      return;
    }

    if (dwellingSaveAllBtn) dwellingSaveAllBtn.disabled = true;
    setStatus(`Saving ${markers.length} dwelling change(s)...`, false);

    let okCount = 0;
    let failCount = 0;
    for (const marker of markers) {
      const useMarkerProperties = marker !== selectedDwellingMarker;
      const saved = await persistDwellingMarker(marker, {
        selectAfterSave: marker === selectedDwellingMarker,
        useMarkerProperties
      });
      if (saved) okCount += 1;
      else failCount += 1;
    }

    updateDwellingSaveAllState();
    if (failCount > 0) {
      setStatus(`Save All finished: ${okCount} saved, ${failCount} failed.`, true);
      return;
    }
    setStatus(`Save All finished: ${okCount} saved.`, false);
  }

  dwellingSaveAllBtn?.addEventListener("click", async () => {
    await saveAllDirtyDwellings();
  });

  function isAddDwellingPointerIntent(src) {
    return Boolean(src && (src.ctrlKey || src.metaKey || src.button === 2));
  }

  let addDwellingInProgress = false;
  async function addDwellingAt(latlng, preferredZoneLayer = null) {
    if (addDwellingInProgress) return;
    addDwellingInProgress = true;
    try {
      if (!canPersistEdits) {
        setStatus("Cannot add dwelling: API source unavailable.", true);
        return;
      }

      const zoneLayer = preferredZoneLayer && getZoneKind(preferredZoneLayer.feature?.properties || {}) === "block"
        ? preferredZoneLayer
        : resolveZoneForDwellingAdd(latlng);
      if (!zoneLayer || getZoneKind(zoneLayer.feature?.properties || {}) !== "block") {
        setStatus("Right-click inside a block polygon to create a dwelling.", true);
        return;
      }

      selectZone(zoneLayer, { showPopup: false });

      if (selectedDwellingMarker) {
        applyMarkerIcon(selectedDwellingMarker, false);
        selectedDwellingMarker = null;
      }

      const zoneProps = zoneLayer.feature?.properties || {};
      const ctxCu = extractCuCode(zoneProps);
      const ctxBlock = extractBlockCode(zoneProps);

      const feature = {
        type: "Feature",
        id: null,
        properties: {
          _group: "dwellings",
          CUID: ctxCu,
          CB_COLCODE: ctxBlock,
          dwellingNo: nextDwellingNoForCu(ctxCu),
          notes: "",
          status: "429",
          photos: [],
          label: ""
        },
        geometry: { type: "Point", coordinates: [latlng.lng, latlng.lat] }
      };

      const marker = createDwellingMarker(feature, { temporary: true });
      if (!marker) {
        setStatus("Failed to add dwelling marker.", true);
        return;
      }

      selectedDwellingMarker = marker;
      applyMarkerIcon(marker, true);
      fillFormFromFeature(feature);

      const saved = await persistDwellingMarker(marker, { selectAfterSave: true });
      if (!saved) {
        setStatus("Dwelling marker created, but save failed.", true);
        return;
      }
      map.flyTo(latlng, Math.max(map.getZoom(), 18), { duration: 0.35 });
    } finally {
      addDwellingInProgress = false;
    }
  }

  map.on("click", (event) => {
    const src = event?.originalEvent;
    if (specialLocationPlacementPending) {
      if (src?.target?.closest?.("#editor-panel, #map-ui, .leaflet-marker-icon, .leaflet-popup")) return;
      src?.preventDefault?.();
      src?.stopPropagation?.();
      void placeSpecialLocation(event.latlng);
      return;
    }
    if (!isAddDwellingPointerIntent(src)) return;
    if (src?.target?.closest?.("#editor-panel, #map-ui")) return;
    src.preventDefault?.();
    src.stopPropagation?.();
    void addDwellingAt(event.latlng, null);
  });

  map.on("contextmenu", (event) => {
    const src = event?.originalEvent;
    if (src?.target?.closest?.("#editor-panel, #map-ui")) return;
    src.preventDefault?.();
    src.stopPropagation?.();
    if (specialLocationPlacementPending) {
      void placeSpecialLocation(event.latlng);
      return;
    }
    void addDwellingAt(event.latlng, null);
  });

  dwellingDeleteBtn?.addEventListener("click", async () => {
    if (!selectedDwellingMarker) {
      setStatus("Select dwelling to delete.", true);
      return;
    }

    const id = getFeatureId(selectedDwellingMarker.feature);
    if (id === null) {
      removeDwellingMarkerLocally(selectedDwellingMarker);
      setStatus("Unsaved dwelling removed", false);
      return;
    }

    if (!canPersistEdits) {
      setStatus("Cannot delete dwelling: API source unavailable.", true);
      return;
    }

    try {
      await getJson(`/api/cld/${cld}/features/${id}`, { method: "DELETE" });
      removeDwellingMarkerLocally(selectedDwellingMarker);
      setStatus("Dwelling deleted", false);
    } catch (error) {
      setStatus(`Delete failed: ${error.message}`, true);
    }
  });

  collapseBtn?.addEventListener("click", () => {
    if (!formWrap) return;
    const collapsed = formWrap.classList.toggle("collapsed");
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.textContent = collapsed ? "Dwellings Editor" : "Dwellings Editor";
  });

  function upsertUserLocation(latlng, accuracyMeters) {
    lastKnownLatLng = latlng;

    if (!userMarker) {
      const icon = L.icon({
        iconUrl: "/person-marker.svg?v=20260721e",
        iconSize: [36, 36],
        iconAnchor: [18, 30]
      });
      userMarker = L.marker(latlng, {
        icon,
        pane: "user-location-pane",
        interactive: false,
        zIndexOffset: 1000
      }).addTo(map);
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
        const position = await geoPlugin.getCurrentPosition({
          enableHighAccuracy: true,
          timeout: 20000,
          maximumAge: 0
        });
        return position;
      } catch {
        // Continue with browser geolocation fallback.
      }
    }

    if (!navigator.geolocation) return null;
    return new Promise((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve(pos),
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
        // Keep silent; user may deny permission.
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
})();
