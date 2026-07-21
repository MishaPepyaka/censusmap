(async function initViewer() {
  const routeMatch = window.location.pathname.match(/^\/(\d+)(?:\/)?$/);
  const cld = routeMatch ? routeMatch[1] : "";
  if (!cld) {
    window.location.replace("/");
    return;
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

  const routeLabel = document.getElementById("route-label");
  const routeSubtitle = document.getElementById("route-subtitle");
  const editRouteLink = document.getElementById("edit-route-link");
  const locateBtn = document.getElementById("locate-btn");
  const baseMapBtn = document.getElementById("basemap-btn");
  const searchInput = document.getElementById("dwelling-search-input");
  const searchBtn = document.getElementById("dwelling-search-btn");
  const searchStatus = document.getElementById("dwelling-search-status");
  const ssidSearchInput = document.getElementById("ssid-search-input");
  const ssidSearchBtn = document.getElementById("ssid-search-btn");
  const ssidSearchStatus = document.getElementById("ssid-search-status");
  let currentUser = null;

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
    if (group === "dwellings" || group === "dwelling") return true;
    return hasDwellingIdentifier(props);
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
      dwellings: features.filter((feature) => isDwellingFeature(feature.properties || {}, feature.geometry || {}))
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
    const apiData = await getJson(`/api/cld/${cld}/features`);
    return parseFeatures(apiData);
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

  function setSearchStatus(message, isError = false) {
    if (!searchStatus) return;
    searchStatus.textContent = message || "";
    searchStatus.classList.toggle("search-status-error", Boolean(isError));
  }

  function setSsidSearchStatus(message, isError = false) {
    if (!ssidSearchStatus) return;
    ssidSearchStatus.textContent = message || "";
    ssidSearchStatus.classList.toggle("search-status-error", Boolean(isError));
  }

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true
  }).setView([56.0, -96.0], 4);
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
  routeSubtitle.textContent = `${summary.counts?.cu || 0} CU · ${summary.counts?.blocks || 0} blocks`;

  const zones = mapData.zones;
  const dwellings = mapData.dwellings;
  const cuCodes = zones.map((feature) => extractCuCode(feature.properties || {}));
  const colorMap = buildColorMap(cuCodes);

  function styleForFeature(feature, selected) {
    const props = feature?.properties || {};
    const cu = extractCuCode(props);
    const color = colorMap.get(cu) || { stroke: "#15803d", fill: "#22c55e" };
    const zoneKind = getZoneKind(props);
    const isCu = zoneKind === "cu";
    return {
      color: color.stroke,
      fillColor: color.fill,
      fillOpacity: isCu ? (selected ? 0.18 : 0.08) : (selected ? 0.34 : 0.2),
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
    const gmapsUrl = getGoogleMapsLink(point.lat, point.lng);
    const shareTitle = block ? `Block ${cu}/${block}` : `CU ${cu}`;
    layer.bindPopup([
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(shareTitle)}</div>`,
      `<div class="dw-popup-meta">CU: ${escapeHtml(cu)}<br>${details}</div>`,
      `<div class="dw-popup-actions">`,
      `<button type="button" class="dw-action-btn dw-action-share" data-code="${escapeHtml(shareTitle)}" data-url="${escapeHtml(gmapsUrl)}">Share Link</button>`,
      `<a class="dw-action-btn dw-action-open" href="${escapeHtml(gmapsUrl)}" target="_blank" rel="noreferrer">Google Maps</a>`,
      `</div>`,
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
      const shareBtn = root?.querySelector(".dw-action-share");
      if (!shareBtn) return;
      shareBtn.addEventListener("click", async (shareEvent) => {
        shareEvent.preventDefault();
        const url = shareBtn.getAttribute("data-url") || "";
        const code = shareBtn.getAttribute("data-code") || "Map location";
        try {
          if (navigator.share) {
            await navigator.share({ title: code, text: code, url });
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            const old = shareBtn.textContent;
            shareBtn.textContent = "Copied";
            window.setTimeout(() => {
              shareBtn.textContent = old;
            }, 1200);
          } else {
            window.prompt("Copy link:", url);
          }
        } catch {
          // Ignore share cancellation.
        }
      }, { once: true });
    });
  });
  badgesReady = true;
  rebuildBadges();

  function redrawPolygonLayers() {
    polygonLayer.eachLayer((layer) => {
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

  function setSelectedDwelling(marker) {
    if (selectedDwellingMarker && selectedDwellingMarker !== marker) {
      const prevNo = selectedDwellingMarker?.__dwellingInfo?.displayNo || "0";
      selectedDwellingMarker.setIcon(getDwellingIconForZoom(prevNo, selectedDwellingMarker.__dwellingInfo?.status, false));
    }
    selectedDwellingMarker = marker;
    if (selectedDwellingMarker) {
      const no = selectedDwellingMarker?.__dwellingInfo?.displayNo || "0";
      selectedDwellingMarker.setIcon(getDwellingIconForZoom(no, selectedDwellingMarker.__dwellingInfo?.status, true));
    }
  }

  function buildDwellingPopupHtml(info) {
    const extraInfo = [];
    if (info.status) extraInfo.push(`Status: ${escapeHtml(info.status)}`);
    return [
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(info.code)}</div>`,
      `<div class="dw-popup-meta">CU ${escapeHtml(info.cu)} · Block ${escapeHtml(info.block)} · Dwelling ${escapeHtml(info.displayNo)}</div>`,
      extraInfo.length > 0 ? `<div class="dw-popup-meta">${extraInfo.join(" · ")}</div>` : "",
      `<div class="dw-popup-actions">`,
      `<button type="button" class="dw-action-btn dw-action-share" data-code="${escapeHtml(info.code)}" data-url="${escapeHtml(info.gmapsUrl)}">Share Link</button>`,
      `<a class="dw-action-btn dw-action-open" href="${escapeHtml(info.gmapsUrl)}" target="_blank" rel="noreferrer">Google Maps</a>`,
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
      status: normalizeDwellingStatus(props.status)
    };
  }

  function createDwellingMarker(record) {
    const marker = L.marker([record.lat, record.lng], {
      icon: getDwellingIconForZoom(record.displayNo, record.status, false),
      keyboard: true
    }).addTo(dwellingsLayer);
    marker.__dwellingInfo = record;
    marker.bindPopup(buildDwellingPopupHtml(record), { autoPan: true });
    marker.on("click", () => setSelectedDwelling(marker));
    marker.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
      const shareBtn = root?.querySelector(".dw-action-share");
      if (!shareBtn) return;
      shareBtn.addEventListener("click", async (shareEvent) => {
        shareEvent.preventDefault();
        const url = shareBtn.getAttribute("data-url") || "";
        const codeValue = shareBtn.getAttribute("data-code") || "";
        const text = `Dwelling ${codeValue}`;
        try {
          if (navigator.share) {
            await navigator.share({ title: text, text, url });
          } else if (navigator.clipboard?.writeText) {
            await navigator.clipboard.writeText(url);
            const old = shareBtn.textContent;
            shareBtn.textContent = "Copied";
            window.setTimeout(() => {
              shareBtn.textContent = old;
            }, 1200);
          } else {
            window.prompt("Copy link:", url);
          }
        } catch {
          // Ignore share cancellation.
        }
      }, { once: true });
    });

    dwellingMarkerByKey.set(record.key, marker);
    return marker;
  }

  const DWELLINGS_MIN_VISIBLE_ZOOM = 10;

  function renderVisibleDwellingMarkers() {
    const selectedKey = selectedDwellingMarker?.__dwellingInfo?.key || null;
    dwellingsLayer.clearLayers();
    dwellingMarkerByKey.clear();
    selectedDwellingMarker = null;

    if (map.getZoom() < DWELLINGS_MIN_VISIBLE_ZOOM) {
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
  renderVisibleDwellingMarkers();
  map.on("zoomend", renderVisibleDwellingMarkers);

  function focusDwelling(record, setStatusText = true) {
    if (!record) return;
    if (map.getZoom() < DWELLINGS_MIN_VISIBLE_ZOOM) {
      map.setZoom(DWELLINGS_MIN_VISIBLE_ZOOM);
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
    if (!digits) return { record: null, message: "Enter code like 462211020079", error: true };

    if (digits.length >= 12) {
      const cu = digits.slice(0, 8);
      const no = digits.slice(-4);
      const code = `${cu}${no}`;
      const list = dwellingByCode.get(code) || [];
      return list.length > 0
        ? { record: list[0], message: "", error: false }
        : { record: null, message: `Not found: ${code}`, error: true };
    }

    if (digits.length === 8) {
      const list = dwellingByCu.get(digits) || [];
      if (list.length === 0) return { record: null, message: `No dwellings in CU ${digits}`, error: true };
      return { record: list[0], message: `CU ${digits}: showing first dwelling`, error: false };
    }

    if (digits.length <= 4) {
      const no = digits.padStart(4, "0");
      const list = dwellingByNo.get(no) || [];
      if (list.length === 0) return { record: null, message: `No dwelling ${no}`, error: true };
      if (list.length > 1) return { record: list[0], message: `Multiple ${no}, showing first match`, error: false };
      return { record: list[0], message: "", error: false };
    }

    return { record: null, message: "Use 4, 8, or 12+ digits", error: true };
  }

  function handleSearch() {
    const result = findDwellingByInput(searchInput?.value || "");
    if (!result.record) {
      setSearchStatus(result.message, true);
      return;
    }
    focusDwelling(result.record, false);
    setSearchStatus(result.message || "Found", false);
  }

  searchBtn?.addEventListener("click", handleSearch);
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      handleSearch();
    }
  });

  async function handleSsidSearch() {
    const value = String(ssidSearchInput?.value || "").trim();
    if (!value) {
      setSsidSearchStatus("Enter an SSID.", true);
      return;
    }
    setSsidSearchStatus("Resolving...");
    try {
      const result = await getJson(`/api/lookup?q=${encodeURIComponent(value)}`);
      if (String(result?.cld || "") === cld) {
        setSsidSearchStatus(`SSID belongs to CLD ${cld}.`, false);
        return;
      }
      window.location.assign(`/${result.cld}`);
    } catch (error) {
      setSsidSearchStatus(error.message, true);
    }
  }

  ssidSearchBtn?.addEventListener("click", () => {
    void handleSsidSearch();
  });
  ssidSearchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void handleSsidSearch();
    }
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

  function upsertUserLocation(latlng, accuracyMeters) {
    lastKnownLatLng = latlng;
    if (!userMarker) {
      const icon = L.divIcon({
        className: "user-person-wrap",
        html: '<span class="user-person-marker"><span class="user-person-head"></span><span class="user-person-body"></span></span>',
        iconSize: [24, 32],
        iconAnchor: [12, 24]
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
