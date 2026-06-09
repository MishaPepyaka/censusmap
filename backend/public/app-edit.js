(async function initEditor() {
  const routeMatch = window.location.pathname.match(/^\/(\d+)\/edit(?:\/)?$/);
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
  const dirtyIds = new Set();
  const dwellingMarkersById = new Map();

  const saveBtn = document.getElementById("save-edits-btn");
  const statusEl = document.getElementById("editor-status");
  const uploadStatusEl = document.getElementById("upload-status");
  const editorRouteLabel = document.getElementById("editor-route-label");
  const editorViewLink = document.getElementById("editor-view-link");

  const collapseBtn = document.getElementById("dwellings-collapse-btn");
  const formWrap = document.getElementById("dwellings-form-wrap");
  const dwellingFields = {
    cu: document.getElementById("dwelling-cu"),
    block: document.getElementById("dwelling-block"),
    no: document.getElementById("dwelling-no"),
    type: document.getElementById("dwelling-type"),
    civic: document.getElementById("dwelling-civic"),
    status: document.getElementById("dwelling-status"),
    contact: document.getElementById("dwelling-contact"),
    link: document.getElementById("dwelling-link"),
    photo: document.getElementById("dwelling-photo"),
    description: document.getElementById("dwelling-description"),
    notes: document.getElementById("dwelling-notes"),
    occupied: document.getElementById("dwelling-occupied")
  };
  const dwellingNewBtn = document.getElementById("dwelling-new-btn");
  const dwellingAddBtn = document.getElementById("dwelling-add-btn");
  const dwellingSaveBtn = document.getElementById("dwelling-save-btn");
  const dwellingSaveAllBtn = document.getElementById("dwelling-save-all-btn");
  const dwellingDeleteBtn = document.getElementById("dwelling-delete-btn");
  const dwellingDeleteSelectionBtn = document.getElementById("dwelling-delete-selection-btn");
  const photoUploadBtn = document.getElementById("photo-upload-btn");
  const dwellingPhotoCaptureInput = document.getElementById("dwelling-photo-capture-input");
  const editorPhotoUploadInput = document.getElementById("editor-photo-upload-input");
  const alignSourceInput = document.getElementById("align-source");
  const alignStartBtn = document.getElementById("align-start-btn");
  const alignApplyBtn = document.getElementById("align-apply-btn");
  const alignCancelBtn = document.getElementById("align-cancel-btn");
  let alignSession = null;
  const dirtyDwellingMarkers = new Set();
  let pendingUploadCreatesDwelling = false;

  if (editorRouteLabel) {
    editorRouteLabel.textContent = `CLD ${cld} editor`;
  }
  if (editorViewLink) {
    editorViewLink.href = `/${cld}`;
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

  function setUploadStatus(message, isError = false) {
    if (!uploadStatusEl) return;
    uploadStatusEl.textContent = message || "";
    uploadStatusEl.classList.toggle("editor-status-error", Boolean(isError));
  }

  function updateSaveState() {
    if (!saveBtn) return;
    saveBtn.disabled = dirtyIds.size === 0;
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
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  async function getMapData() {
    try {
      const data = await getJson(`/api/cld/${cld}/features`);
      const features = (data.features || []).filter((f) => !isExcludedCuFeature(f));
      return {
        source: "api",
        loadError: "",
        blocks: features.filter((f) => isZoneFeature(f)),
        dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {}))
      };
    } catch (apiError) {
      return {
        source: "none",
        loadError: `Data load failed: API (${apiError.message})`,
        blocks: [],
        dwellings: []
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

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true,
    inertia: false
  }).setView([56.0, -96.0], 4);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  const vectorRenderer = L.svg({ padding: 0.5 });
  const mapContainer = map.getContainer();
  function syncZoomUiMode() {
    const cuOnly = map.getZoom() <= 12;
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
  const canPersistEdits = data.source === "api";

  if (data.loadError) {
    setStatus(data.loadError, true);
  }

  const cuCodes = blocks.map((f) => extractCuCode(f.properties || {}));
  const colorMap = buildColorMap(cuCodes);

  function styleForFeature(feature, selected) {
    const props = feature?.properties || {};
    const cu = extractCuCode(props);
    const color = colorMap.get(cu) || { stroke: "#15803d", fill: "#22c55e" };
    const isCu = getZoneKind(props) === "cu";
    return {
      color: color.stroke,
      fillColor: color.fill,
      fillOpacity: isCu ? (selected ? 0.18 : 0.08) : (selected ? 0.38 : 0.24),
      weight: selected ? 4 : (isCu ? 3 : 2),
      dashArray: isCu ? "8 6" : null,
      opacity: 0.95
    };
  }

  const editableLayer = L.featureGroup().addTo(map);
  const badgeLayer = L.layerGroup().addTo(map);
  const dwellingsLayer = L.layerGroup().addTo(map);
  const blockLayers = [];

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
      layer.bindPopup(`CU: ${cu}<br>${details}`, { autoPan: false });
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

  function getDwellingMarkersInZone(zoneLayer) {
    if (!zoneLayer?.feature) return [];
    const out = [];
    dwellingsLayer.eachLayer((marker) => {
      if (featureContainsLatLng(zoneLayer.feature, marker.getLatLng())) {
        out.push(marker);
      }
    });
    return out;
  }

  function getSelectionDwellingMarkers() {
    if (alignSession?.targets?.length) {
      return alignSession.targets.map((target) => target.marker);
    }
    if (selectedPolygonLayer) {
      return getDwellingMarkersInZone(selectedPolygonLayer);
    }
    return [];
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

  function dwellingMarkerIcon(no, selected) {
    return L.divIcon({
      className: "dwelling-marker-wrap",
      html: `<span class="dwelling-marker ${selected ? "selected" : ""}">${String(no)}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  function buildDwellingPopupHtml(feature) {
    const props = feature?.properties || {};
    const geom = feature?.geometry || {};
    const lat = Number(geom?.coordinates?.[1]);
    const lng = Number(geom?.coordinates?.[0]);
    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const displayNo = displayDwellingNo(props);
    const code = `${cu}${extractDwellingNo(props)}`;
    const gmapsUrl = Number.isFinite(lat) && Number.isFinite(lng) ? getGoogleMapsLink(lat, lng) : "";
    const meta = [];
    if (props.civicNo || props.civic) meta.push(`Civic: ${escapeHtml(props.civicNo || props.civic)}`);
    if (props.status) meta.push(`Status: ${escapeHtml(props.status)}`);
    if (props.description) meta.push(escapeHtml(props.description));
    return [
      `<div class="dw-popup">`,
      `<div class="dw-popup-code">${escapeHtml(code)}</div>`,
      `<div class="dw-popup-meta">CU ${escapeHtml(cu)} · Block ${escapeHtml(block)} · Dwelling ${escapeHtml(displayNo)}</div>`,
      meta.length > 0 ? `<div class="dw-popup-meta">${meta.join(" · ")}</div>` : "",
      gmapsUrl ? `<div class="dw-popup-actions">` : "",
      gmapsUrl ? `<button type="button" class="dw-action-btn dw-action-share" data-code="${escapeHtml(code)}" data-url="${escapeHtml(gmapsUrl)}">Share Link</button>` : "",
      gmapsUrl ? `<a class="dw-action-btn dw-action-open" href="${escapeHtml(gmapsUrl)}" target="_blank" rel="noreferrer">Open Google Maps</a>` : "",
      gmapsUrl ? `</div>` : "",
      `</div>`
    ].join("");
  }

  function attachDwellingPopupHandlers(marker) {
    marker.bindPopup(buildDwellingPopupHtml(marker.feature), { autoPan: true });
    marker.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
      const shareBtn = root?.querySelector(".dw-action-share");
      if (!shareBtn) return;
      shareBtn.addEventListener("click", async (shareEvent) => {
        shareEvent.preventDefault();
        const url = shareBtn.getAttribute("data-url") || "";
        const code = shareBtn.getAttribute("data-code") || "";
        const text = `Dwelling ${code}`;
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
  }

  function markerFeature(marker) {
    return marker?.feature || null;
  }

  function applyMarkerIcon(marker, selected) {
    const feature = markerFeature(marker);
    if (!feature) return;
    const no = displayDwellingNo(feature.properties || {});
    marker.setIcon(dwellingMarkerIcon(no, selected));
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
    if (id !== null) dwellingMarkersById.delete(id);

    if (alignSession) {
      alignSession.targets = alignSession.targets.filter((target) => target.marker !== marker);
      if (alignSession.targets.length === 0) {
        teardownAlignSession();
      } else {
        updateAlignmentLive(alignSession);
      }
    }
  }

  function fillFormFromFeature(feature) {
    const props = feature?.properties || {};
    dwellingFields.cu.value = extractCuCode(props);
    dwellingFields.block.value = extractBlockCode(props);
    dwellingFields.no.value = extractDwellingNo(props);
    dwellingFields.type.value = props.dwellingType || props.type || "";
    dwellingFields.civic.value = props.civicNo || props.civic || "";
    dwellingFields.status.value = props.status || "";
    dwellingFields.contact.value = props.contact || "";
    dwellingFields.link.value = props.externalLink || "";
    dwellingFields.photo.value = props.photo || "";
    dwellingFields.description.value = props.description || "";
    dwellingFields.notes.value = props.notes || "";
    dwellingFields.occupied.checked = !(props.occupied === false || String(props.occupied).toLowerCase() === "false");
  }

  function featureFromForm(existingId, latlng) {
    const cu = String(dwellingFields.cu.value || "").trim();
    const block = String(dwellingFields.block.value || "").trim().padStart(2, "0");
    const dwellingNo = formatDwellingNo(dwellingFields.no.value || "");
    if (!isNonEmpty(cu)) throw new Error("CU is required");
    if (!/^[0-9]{2}$/.test(block)) throw new Error("Block must be 2 digits");
    if (!/^[0-9]{4}$/.test(dwellingNo)) throw new Error("Dwelling No must be 4 digits");

    const occupied = Boolean(dwellingFields.occupied.checked);
    const properties = {
      _group: "dwellings",
      CUID: cu,
      CB_COLCODE: block,
      dwellingNo,
      dwellingType: String(dwellingFields.type.value || "").trim(),
      description: String(dwellingFields.description.value || "").trim(),
      occupied,
      notes: String(dwellingFields.notes.value || "").trim(),
      contact: String(dwellingFields.contact.value || "").trim(),
      status: String(dwellingFields.status.value || "").trim(),
      externalLink: String(dwellingFields.link.value || "").trim(),
      photo: String(dwellingFields.photo.value || "").trim(),
      photos: Array.isArray(selectedDwellingMarker?.feature?.properties?.photos)
        ? [...selectedDwellingMarker.feature.properties.photos]
        : [],
      civicNo: String(dwellingFields.civic.value || "").trim(),
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
    const cu = String(original.CUID ?? original.cu ?? "").trim();
    const block = String(original.CB_COLCODE ?? original.block ?? "").trim().padStart(2, "0");
    const dwellingNo = formatDwellingNo(original.dwellingNo ?? original.DWELLING_NO ?? original.vrNumber ?? original.VR_NUMBER ?? "");
    if (!isNonEmpty(cu)) throw new Error("CU is required");
    if (!/^[0-9]{2}$/.test(block)) throw new Error("Block must be 2 digits");
    if (!/^[0-9]{4}$/.test(dwellingNo)) throw new Error("Dwelling No must be 4 digits");

    const occupied =
      original.occupied === true ||
      (typeof original.occupied === "string" && original.occupied.toLowerCase() === "true");
    const properties = {
      ...original,
      _group: "dwellings",
      CUID: cu,
      CB_COLCODE: block,
      dwellingNo,
      dwellingType: String(original.dwellingType ?? original.type ?? "").trim(),
      description: String(original.description ?? "").trim(),
      occupied,
      notes: String(original.notes ?? "").trim(),
      contact: String(original.contact ?? "").trim(),
      status: String(original.status ?? "").trim(),
      externalLink: String(original.externalLink ?? "").trim(),
      photo: String(original.photo ?? "").trim(),
      civicNo: String(original.civicNo ?? original.civic ?? "").trim(),
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

  function getSourceTag() {
    return String(alignSourceInput?.value || "").trim();
  }

  function getDwellingMarkersBySource(sourceTag) {
    const out = [];
    dwellingsLayer.eachLayer((marker) => {
      const props = marker.feature?.properties || {};
      if (String(props.source || "").trim() !== sourceTag) return;
      out.push(marker);
    });
    return out;
  }

  function getBoundsFromMarkers(markers) {
    if (!markers || markers.length === 0) return null;
    const points = markers.map((marker) => marker.getLatLng());
    return L.latLngBounds(points);
  }

  function alignHandleIcon(kind, mode = "resize") {
    let className = "align-handle";
    if (kind === "center") className = "align-center";
    if (kind === "corner" && mode === "rotate") className = "align-handle align-handle-rotate";
    return L.divIcon({
      className: "align-handle-wrap",
      html: `<span class="${className}"></span>`,
      iconSize: [14, 14],
      iconAnchor: [7, 7]
    });
  }

  function teardownAlignSession() {
    if (!alignSession) return;
    map.removeLayer(alignSession.rectLayer);
    map.removeLayer(alignSession.cornerMarker);
    map.removeLayer(alignSession.centerMarker);
    alignSession = null;
  }

  function metersScalesForLat(lat) {
    return {
      mPerDegLat: 111320,
      mPerDegLng: 111320 * Math.cos((Math.PI / 180) * lat)
    };
  }

  function latLngToLocalMeters(target, center) {
    const { mPerDegLat, mPerDegLng } = metersScalesForLat(center.lat);
    return {
      x: (target.lng - center.lng) * mPerDegLng,
      y: (target.lat - center.lat) * mPerDegLat
    };
  }

  function localMetersToLatLng(local, center) {
    const { mPerDegLat, mPerDegLng } = metersScalesForLat(center.lat);
    const lng = center.lng + local.x / mPerDegLng;
    const lat = center.lat + local.y / mPerDegLat;
    return L.latLng(lat, lng);
  }

  function rotateLocal(vec, angleRad) {
    const c = Math.cos(angleRad);
    const s = Math.sin(angleRad);
    return {
      x: vec.x * c - vec.y * s,
      y: vec.x * s + vec.y * c
    };
  }

  function alignmentSquareCorners(session) {
    const h = Math.max(5, session.halfSideM);
    const base = [
      { x: -h, y: -h },
      { x: h, y: -h },
      { x: h, y: h },
      { x: -h, y: h }
    ];
    return base.map((pt) => {
      const rot = rotateLocal(pt, session.angleRad);
      return localMetersToLatLng(rot, session.center);
    });
  }

  function alignmentCornerLatLng(session) {
    const h = Math.max(5, session.halfSideM);
    const rot = rotateLocal({ x: h, y: h }, session.angleRad);
    return localMetersToLatLng(rot, session.center);
  }

  function updateAlignmentLive(session) {
    const corners = alignmentSquareCorners(session);
    session.rectLayer.setLatLngs(corners);
    session.centerMarker.setLatLng(session.center);
    session.cornerMarker.setLatLng(alignmentCornerLatLng(session));

    for (const target of session.targets) {
      const local = rotateLocal(
        {
          x: target.nx * session.halfSideM,
          y: target.ny * session.halfSideM
        },
        session.angleRad
      );
      const ll = localMetersToLatLng(local, session.center);
      target.marker.setLatLng(ll);
      target.marker.feature.geometry = {
        type: "Point",
        coordinates: [Number(ll.lng), Number(ll.lat)]
      };
    }
  }

  async function saveAlignmentMarkers(session) {
    let okCount = 0;
    let failCount = 0;
    for (const target of session.targets) {
      const saved = await persistDwellingMarker(target.marker, {
        selectAfterSave: false,
        useMarkerProperties: true
      });
      if (saved) okCount += 1;
      else failCount += 1;
    }
    return { okCount, failCount };
  }

  function toggleAlignMode() {
    if (!alignSession) return;
    alignSession.mode = alignSession.mode === "resize" ? "rotate" : "resize";
    alignSession.cornerMarker.setIcon(alignHandleIcon("corner", alignSession.mode));
    setStatus(`Alignment corner mode: ${alignSession.mode.toUpperCase()}`, false);
  }

  function createDwellingMarker(feature, { temporary = false } = {}) {
    const geom = feature?.geometry || {};
    if (geom.type !== "Point" || !Array.isArray(geom.coordinates)) return null;
    const lat = Number(geom.coordinates[1]);
    const lng = Number(geom.coordinates[0]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

    const marker = L.marker([lat, lng], {
      icon: dwellingMarkerIcon(displayDwellingNo(feature.properties || {}), false),
      draggable: canPersistEdits,
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
    if (temporary) {
      markDwellingDirty(marker);
    }

    marker.on("click", () => {
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
      if (selectedDwellingMarker === marker) {
        setStatus("Dwelling position changed. Press Save or Save All.", false);
      }
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
      layer.redraw?.();
    });
    if (badgesReady) rebuildBadges();
  }
  map.on("zoomend", redrawEditableZones);
  map.on("moveend", redrawEditableZones);
  map.on("viewreset", redrawEditableZones);

  for (const feature of dwellings) {
    createDwellingMarker(feature);
  }
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

  if (canPersistEdits) {
    if (!L.Control || !L.Control.Draw) {
      setStatus("leaflet.draw is missing; geometry editing disabled.", true);
    } else {
    const drawControl = new L.Control.Draw({
      draw: false,
      edit: {
        featureGroup: editableLayer,
        edit: true,
        remove: false
      }
    });
    map.addControl(drawControl);

    map.on(L.Draw.Event.EDITED, (event) => {
      event.layers.eachLayer((layer) => {
        const id = getFeatureId(layer.feature);
        if (id !== null) dirtyIds.add(id);
        layer.feature.geometry = layer.toGeoJSON().geometry;
      });
      rebuildBadges();
      updateSaveState();
      setStatus(`${dirtyIds.size} zone(s) changed. Press Save Geometry.`, false);
    });
    }
  } else {
    if (!data.loadError) {
      setStatus("Editing disabled: loaded local blocks.geojson (no API IDs).", true);
    }
  }

  async function saveGeometryChanges() {
    if (!canPersistEdits) {
      setStatus("Cannot save: API source is unavailable.", true);
      return;
    }
    if (dirtyIds.size === 0) {
      setStatus("No pending changes", false);
      return;
    }

    const layersById = new Map();
    editableLayer.eachLayer((layer) => {
      const id = getFeatureId(layer.feature);
      if (id !== null) layersById.set(id, layer);
    });

    const ids = [...dirtyIds];
    saveBtn.disabled = true;
    setStatus(`Saving ${ids.length} zone(s)...`, false);

    try {
      for (const id of ids) {
        const layer = layersById.get(id);
        if (!layer) continue;
        const geometry = layer.toGeoJSON().geometry;
        const payload = {
          type: "Feature",
          id,
          properties: { ...(layer.feature?.properties || {}) },
          geometry
        };

        await getJson(`/api/cld/${cld}/features/${id}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        });

        layer.feature.geometry = geometry;
        layer.setStyle(styleForFeature(layer.feature, false));
        dirtyIds.delete(id);
      }

      selectedPolygonLayer = null;
      updateSaveState();
      setStatus("Geometry saved", false);
    } catch (error) {
      updateSaveState();
      setStatus(`Save failed: ${error.message}`, true);
    }
  }

  saveBtn?.addEventListener("click", async () => {
    await saveGeometryChanges();
  });

  function clearDwellingForm() {
    dwellingFields.cu.value = "";
    dwellingFields.block.value = "";
    dwellingFields.no.value = "";
    dwellingFields.type.value = "";
    dwellingFields.civic.value = "";
    dwellingFields.status.value = "";
    dwellingFields.contact.value = "";
    dwellingFields.link.value = "";
    dwellingFields.photo.value = "";
    dwellingFields.description.value = "";
    dwellingFields.notes.value = "";
    dwellingFields.occupied.checked = true;
  }

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
        dwellingType: "",
        description: "",
        occupied: true,
        notes: "",
        contact: "",
        status: "",
        externalLink: "",
        photo: "",
        photos: [],
        civicNo: "",
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

  async function fileToDataUrl(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read image"));
      reader.readAsDataURL(file);
    });
  }

  async function uploadImageFile(file) {
    const dataUrl = await fileToDataUrl(file);
    const response = await getJson(`/api/cld/${cld}/uploads`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        filename: file.name,
        mimeType: file.type || "image/jpeg",
        dataUrl
      })
    });
    return response.upload;
  }

  function appendUploadedPhotoToMarker(marker, upload) {
    if (!marker?.feature?.properties || !upload?.compressedUrl) return;
    const properties = marker.feature.properties;
    const photos = Array.isArray(properties.photos) ? [...properties.photos] : [];
    photos.push(upload.compressedUrl);
    properties.photos = photos;
    properties.photo = upload.compressedUrl;
    dwellingFields.photo.value = upload.compressedUrl;
    markDwellingDirty(marker);
  }

  async function handleUploadedFiles(files, createDwellingFromFirst) {
    const pickedFiles = Array.from(files || []);
    if (pickedFiles.length === 0) return;

    setUploadStatus(`Uploading ${pickedFiles.length} image(s)...`);

    try {
      const uploads = [];
      for (const file of pickedFiles) {
        uploads.push(await uploadImageFile(file));
      }

      if (createDwellingFromFirst) {
        const firstUpload = uploads[0];
        const marker = createNewDwellingDraft({
          photo: firstUpload.compressedUrl,
          photos: uploads.map((upload) => upload.compressedUrl)
        });
        if (marker) {
          marker.feature.properties.photo = firstUpload.compressedUrl;
          marker.feature.properties.photos = uploads.map((upload) => upload.compressedUrl);
          fillFormFromFeature(marker.feature);
          setStatus("Photo uploaded. Position the dwelling and press Save.", false);
        }
      } else if (selectedDwellingMarker) {
        for (const upload of uploads) {
          appendUploadedPhotoToMarker(selectedDwellingMarker, upload);
        }
        setStatus(`Attached ${uploads.length} photo(s) to dwelling. Press Save.`, false);
      } else {
        const firstUpload = uploads[0];
        dwellingFields.photo.value = firstUpload.compressedUrl;
        setStatus(`Uploaded ${uploads.length} photo(s). Select or create a dwelling to save them.`, false);
      }

      setUploadStatus(`Uploaded ${uploads.length} image(s).`, false);
    } catch (error) {
      setUploadStatus(`Upload failed: ${error.message}`, true);
      setStatus(`Upload failed: ${error.message}`, true);
    }
  }

  dwellingAddBtn?.addEventListener("click", () => {
    pendingUploadCreatesDwelling = true;
    dwellingPhotoCaptureInput?.click();
  });

  photoUploadBtn?.addEventListener("click", () => {
    pendingUploadCreatesDwelling = false;
    editorPhotoUploadInput?.click();
  });

  dwellingPhotoCaptureInput?.addEventListener("change", async (event) => {
    await handleUploadedFiles(event.target.files, pendingUploadCreatesDwelling);
    event.target.value = "";
    pendingUploadCreatesDwelling = false;
  });

  editorPhotoUploadInput?.addEventListener("change", async (event) => {
    await handleUploadedFiles(event.target.files, false);
    event.target.value = "";
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
      setStatus(`Dwelling ${extractDwellingNo(payload.properties || {})} saved`, false);
      return true;
    } catch (error) {
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
      markDwellingDirty(selectedDwellingMarker);
      setStatus("Dwelling fields changed. Press Save or Save All.", false);
    });
  }

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
          dwellingType: "",
          description: "",
          occupied: true,
          notes: "",
          contact: "",
          status: "",
          externalLink: "",
          photo: "",
          civicNo: "",
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
    void addDwellingAt(event.latlng, null);
  });

  function startAlignmentBox() {
    const sourceTag = getSourceTag();
    let markers = [];
    if (isNonEmpty(sourceTag)) {
      markers = getDwellingMarkersBySource(sourceTag);
    }
    let usedAllMarkers = false;
    if (markers.length === 0) {
      usedAllMarkers = true;
      dwellingsLayer.eachLayer((marker) => markers.push(marker));
    }
    if (markers.length === 0) {
      setStatus("No dwellings found for alignment.", true);
      return;
    }

    teardownAlignSession();

    const bounds = getBoundsFromMarkers(markers);
    if (!bounds) {
      setStatus("Cannot build alignment box for empty source.", true);
      return;
    }
    const center = bounds.getCenter();
    const locals = markers.map((marker) => latLngToLocalMeters(marker.getLatLng(), center));
    let maxAbs = 0;
    for (const loc of locals) {
      maxAbs = Math.max(maxAbs, Math.abs(loc.x), Math.abs(loc.y));
    }
    const halfSideM = Math.max(5, maxAbs * 1.15);

    const targets = markers.map((marker, idx) => {
      const loc = locals[idx];
      return {
        marker,
        nx: loc.x / halfSideM,
        ny: loc.y / halfSideM
      };
    });

    const rectLayer = L.polygon([], {
      color: "#f97316",
      weight: 2,
      dashArray: "6 4",
      fillOpacity: 0.06
    }).addTo(map);
    const cornerMarker = L.marker(center, {
      icon: alignHandleIcon("corner", "resize"),
      draggable: true,
      keyboard: false
    }).addTo(map);
    const centerMarker = L.marker(center, {
      icon: alignHandleIcon("center"),
      draggable: true,
      keyboard: false
    }).addTo(map);

    alignSession = {
      sourceTag,
      targets,
      center,
      halfSideM,
      angleRad: 0,
      mode: "resize",
      rectLayer,
      cornerMarker,
      centerMarker
    };

    updateAlignmentLive(alignSession);

    centerMarker.on("drag", () => {
      if (!alignSession) return;
      alignSession.center = centerMarker.getLatLng();
      updateAlignmentLive(alignSession);
    });

    cornerMarker.on("click", (event) => {
      L.DomEvent.stopPropagation(event);
      toggleAlignMode();
    });

    cornerMarker.on("drag", () => {
      if (!alignSession) return;
      const centerNow = alignSession.center;
      const cornerNow = cornerMarker.getLatLng();
      const vec = latLngToLocalMeters(cornerNow, centerNow);
      if (alignSession.mode === "resize") {
        const dist = Math.hypot(vec.x, vec.y);
        alignSession.halfSideM = Math.max(5, dist / Math.SQRT2);
      } else {
        alignSession.angleRad = Math.atan2(vec.y, vec.x) - Math.PI / 4;
      }
      updateAlignmentLive(alignSession);
    });

    centerMarker.on("dragend", async () => {
      if (!alignSession) return;
      const { okCount, failCount } = await saveAlignmentMarkers(alignSession);
      setStatus(`Alignment moved: ${okCount} saved, ${failCount} failed.`, failCount > 0);
    });

    cornerMarker.on("dragend", async () => {
      if (!alignSession) return;
      const { okCount, failCount } = await saveAlignmentMarkers(alignSession);
      setStatus(`Alignment ${alignSession.mode}: ${okCount} saved, ${failCount} failed.`, failCount > 0);
    });

    setStatus(
      `Alignment box active for ${targets.length} dwellings${usedAllMarkers ? " (all markers)" : ""}. Drag center to move; click corner to toggle resize/rotate.`,
      false
    );
  }

  async function applyAlignmentBox() {
    if (!alignSession) {
      setStatus("Alignment box is not active.", true);
      return;
    }
    if (!canPersistEdits) {
      setStatus("Cannot apply alignment: API source unavailable.", true);
      return;
    }

    const { okCount, failCount } = await saveAlignmentMarkers(alignSession);

    if (selectedDwellingMarker) {
      fillFormFromFeature(selectedDwellingMarker.feature);
      applyMarkerIcon(selectedDwellingMarker, true);
    }

    teardownAlignSession();
    if (failCount > 0) {
      setStatus(`Alignment applied with errors: ${okCount} saved, ${failCount} failed.`, true);
      return;
    }
    setStatus(`Alignment applied and saved: ${okCount} dwellings.`, false);
  }

  function cancelAlignmentBox() {
    if (!alignSession) {
      setStatus("Alignment box is not active.", false);
      return;
    }
    teardownAlignSession();
    setStatus("Alignment box canceled.", false);
  }

  alignStartBtn?.addEventListener("click", () => startAlignmentBox());
  alignApplyBtn?.addEventListener("click", async () => {
    await applyAlignmentBox();
  });
  alignCancelBtn?.addEventListener("click", () => cancelAlignmentBox());

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

  dwellingDeleteSelectionBtn?.addEventListener("click", async () => {
    const markers = getSelectionDwellingMarkers();
    if (markers.length === 0) {
      setStatus("No dwellings in current selection.", true);
      return;
    }

    const confirmed = window.confirm(`Delete ${markers.length} dwellings in current selection?`);
    if (!confirmed) return;

    let deleted = 0;
    let failed = 0;
    for (const marker of [...markers]) {
      const id = getFeatureId(marker.feature);
      if (id === null) {
        removeDwellingMarkerLocally(marker);
        deleted += 1;
        continue;
      }
      if (!canPersistEdits) {
        failed += 1;
        continue;
      }

      try {
        await getJson(`/api/cld/${cld}/features/${id}`, { method: "DELETE" });
        removeDwellingMarkerLocally(marker);
        deleted += 1;
      } catch {
        failed += 1;
      }
    }

    if (failed > 0) {
      setStatus(`Delete in selection: ${deleted} deleted, ${failed} failed.`, true);
      return;
    }
    setStatus(`Delete in selection: ${deleted} deleted.`, false);
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
