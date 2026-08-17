(async function initEditor() {
  const {
    isNonEmpty,
    escapeHtml,
    isPolygonGeometry,
    isPointGeometry,
    hasDwellingIdentifier,
    getZoneKind,
    isZoneFeature,
    isDwellingFeature,
    isSpecialLocationFeature,
    extractCuCode,
    buildColorMap
  } = window.CensusMapData;
  const { getJson, getJsonWithTimeout } = window.CensusMapApi;
  const { buildMapActionButtons } = window.CensusMapActions;
  const { readMapUrlState, bindMapUrlState, setupBaseMap, setupTileCacheStatus, createUserLocationTracker } = window.CensusMapRuntime;
  const routeMatch = window.location.pathname.match(/^\/(\d+)\/edit(?:\/)?$/);
  const cld = routeMatch ? routeMatch[1] : "";
  if (!cld) {
    window.location.replace("/");
    return;
  }
  const requestedMapView = readMapUrlState();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The editor remains fully functional when a browser disallows service workers.
    });
  }

  let selectedPolygonLayer = null;
  let selectedDwellingMarker = null;
  let badgesReady = false;
  let editorMode = "editing";
  let specialLocationPlacementPending = false;
  let selectedSpecialLocationMarker = null;
  const dwellingMarkersById = new Map();
  const specialLocationMarkersById = new Map();
  const allDwellingMarkers = new Set();
  const allSpecialLocationMarkers = new Set();

  const statusEl = document.getElementById("editor-status");
  const editorRouteLabel = document.getElementById("editor-route-label");
  const editorRouteSummary = document.getElementById("editor-route-summary");
  const editorViewLink = document.getElementById("editor-view-link");
  const geometryEditorLink = document.getElementById("geometry-editor-link");
  const uploadRefreshBtn = document.getElementById("upload-refresh-btn");
  const syncStatusEl = document.getElementById("editor-sync-status");
  const tileCacheStatus = document.getElementById("tile-cache-status");

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
  const copySsidsBtn = document.getElementById("copy-ssids-btn");
  const copySsidStatusInput = document.getElementById("copy-ssid-status");
  const bulkStatusSsidsInput = document.getElementById("bulk-status-ssids");
  const bulkStatusCodeInput = document.getElementById("bulk-status-code");
  const bulkStatusApplyBtn = document.getElementById("bulk-status-apply-btn");
  const bulkNotesFileInput = document.getElementById("bulk-notes-file");
  const bulkNotesApplyBtn = document.getElementById("bulk-notes-apply-btn");
  const todayUpdatesExportBtn = document.getElementById("today-updates-export-btn");
  const specialLocationTypeInput = document.getElementById("special-location-type");
  const specialLocationNameInput = document.getElementById("special-location-name");
  const specialLocationNotesInput = document.getElementById("special-location-notes");
  const specialLocationGroup = document.getElementById("special-location-group");
  const specialLocationPlaceBtn = document.getElementById("special-location-place-btn");
  const specialLocationSaveBtn = document.getElementById("special-location-save-btn");
  const specialLocationDeleteBtn = document.getElementById("special-location-delete-btn");
  const dwellingMoveToggle = document.getElementById("dwelling-move-toggle");
  const editorModeHelp = document.getElementById("editor-mode-help");
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

  function getViewerShareUrl() {
    return `/${cld}${window.location.search}${window.location.hash}`;
  }

  function setSyncStatus(message, state = "saved") {
    if (!syncStatusEl) return;
    syncStatusEl.textContent = message;
    syncStatusEl.classList.toggle("pending", state === "pending");
    syncStatusEl.classList.toggle("error", state === "error");
  }

  function updateUploadRefreshAvailability() {
    if (!uploadRefreshBtn) return;
    uploadRefreshBtn.disabled = !navigator.onLine;
    uploadRefreshBtn.title = navigator.onLine ? "Upload local changes and download current map changes" : "Unavailable while offline";
  }
  updateUploadRefreshAvailability();
  window.addEventListener("online", updateUploadRefreshAvailability);
  window.addEventListener("offline", updateUploadRefreshAvailability);

  function wait(milliseconds) {
    return new Promise((resolve) => window.setTimeout(resolve, milliseconds));
  }

  function setStatus(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.classList.toggle("editor-status-error", Boolean(isError));
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

  function applyPendingMutations(features) {
    const nextFeatures = Array.isArray(features) ? [...features] : [];
    try {
      const queue = JSON.parse(localStorage.getItem(`cld-map-pending:${cld}`) || "[]");
      if (!Array.isArray(queue)) return nextFeatures;
      for (const item of queue) {
        if (item.method === "POST" && item.payload?.geometry) {
          nextFeatures.push({ ...item.payload, _offlineQueueId: item.id, _offlineMutationKey: item.dedupeKey || item.id });
          continue;
        }
        const id = String(item.payload?.id ?? item.url?.split("/").pop() ?? "");
        const index = nextFeatures.findIndex((feature) => String(getFeatureId(feature) ?? "") === id);
        if (item.method === "PUT" && index >= 0 && item.payload?.geometry) {
          nextFeatures[index] = item.payload;
        } else if (item.method === "DELETE" && index >= 0) {
          nextFeatures.splice(index, 1);
        }
      }
    } catch {
      // A damaged queue must not prevent the saved map from opening.
    }
    return nextFeatures;
  }

  async function getMapData(forceNetwork = false) {
    try {
      if (!navigator.onLine) throw new Error("Offline");
      const data = await getJsonWithTimeout(`/api/cld/${cld}/features${forceNetwork ? `?refresh=${Date.now()}` : ""}`, {}, 15000);
      const features = applyPendingMutations((data.features || []).filter((f) => !isExcludedCuFeature(f)));
      if (features.length === 0) throw new Error("The map server returned an empty feature list");
      // Never let a transient empty response replace a usable offline map.
      if (features.length > 0) window.CldOfflineStore?.saveCachedFeatures(cld, features);
      return {
        source: "api",
        loadError: "",
        blocks: features.filter((f) => isZoneFeature(f)),
        dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {})),
        specialLocations: features.filter((f) => isSpecialLocationFeature(f.properties || {}, f.geometry || {}))
      };
    } catch (apiError) {
      const snapshot = await window.CldOfflineStore?.readCachedFeatures(cld);
      if (Array.isArray(snapshot?.features) && snapshot.features.length > 0) {
        const features = applyPendingMutations(snapshot.features.filter((f) => !isExcludedCuFeature(f)));
        return {
          source: "cache",
          loadError: "Offline: showing the last map saved on this device.",
          blocks: features.filter((f) => isZoneFeature(f)),
          dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {})),
          specialLocations: features.filter((f) => isSpecialLocationFeature(f.properties || {}, f.geometry || {}))
        };
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

  const DWELLING_STATUSES = new Set(["429", "400", "402", "701", "500", "312", "324", "000", "001", "601"]);

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

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true,
    inertia: false
  }).setView([56.0, -96.0], 4);

  const mapUrlState = bindMapUrlState(map, requestedMapView, (query) => {
    if (editorViewLink) editorViewLink.href = `/${cld}?${query}`;
  });
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
  const locateBtn = document.getElementById("locate-btn");
  const baseMapBtn = document.getElementById("basemap-btn");
  const baseMap = setupBaseMap(map, baseMapBtn);
  setupTileCacheStatus(tileCacheStatus, [baseMap.satelliteLayer, baseMap.schematicLayer]);
  const userLocationTracker = createUserLocationTracker(map, { pane: "user-location-pane", zIndexOffset: 1000 });

  if (locateBtn) {
    locateBtn.textContent = "🧍";
    locateBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await userLocationTracker.focus();
    });
  }

  const data = await getMapData();
  const blocks = data.blocks;
  const dwellings = data.dwellings;
  const specialLocations = data.specialLocations;
  const canPersistEdits = data.source === "api" || data.source === "cache";

  function updateEditorRouteSummary() {
    if (!editorRouteSummary) return;
    const cuCodes = new Set();
    let blockCount = 0;
    for (const feature of blocks) {
      const props = feature?.properties || {};
      const cu = extractCuCode(props);
      if (cu) cuCodes.add(cu);
      if (getZoneKind(props) === "block") blockCount += 1;
    }
    const markers = [...allDwellingMarkers];
    const completedStatuses = new Set(["400", "402", "701", "312", "324", "000", "001", "601"]);
    const completed = markers.filter((marker) =>
      completedStatuses.has(normalizeDwellingStatus(marker.feature?.properties?.status))
    ).length;
    const percent = markers.length ? ((completed / markers.length) * 100).toFixed(1) : "0.0";
    editorRouteSummary.textContent = `${cuCodes.size} CU · ${blockCount} blocks · ${markers.length} dwellings · ${completed} completed (${percent}%)`;
  }

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

  const EDITOR_MODES = ["editing", "adding", "relocation"];
  const EDITOR_MODE_LABELS = {
    editing: "Editing mode",
    adding: "Adding mode",
    relocation: "Relocation mode"
  };
  const EDITOR_MODE_HELP = {
    editing: "Edit house and special-location information. Adding and moving are disabled.",
    adding: "Add a house with right-click, Ctrl/Cmd+click, or a long tap inside a block. You can also edit information, but cannot move markers.",
    relocation: "Drag houses and special locations to relocate them. Their positions save automatically; editing remains available, but adding is disabled."
  };

  function isAddingMode() {
    return editorMode === "adding";
  }

  function isRelocationMode() {
    return editorMode === "relocation";
  }

  function syncEditorModeUi() {
    const relocation = isRelocationMode();
    const adding = isAddingMode();
    if (formWrap) {
      for (const control of formWrap.querySelectorAll("input, select, textarea, button")) {
        control.disabled = false;
      }
    }
    if (dwellingNewBtn) dwellingNewBtn.disabled = !adding || !canPersistEdits;
    if (specialLocationPlaceBtn) specialLocationPlaceBtn.disabled = !adding || !canPersistEdits;
    updateDwellingSaveAllState();
    document.querySelectorAll(".dw-status-select").forEach((select) => {
      select.disabled = false;
    });
    dwellingMoveToggle?.classList.toggle("is-enabled", relocation);
    dwellingMoveToggle?.classList.toggle("is-adding", adding);
    if (dwellingMoveToggle) {
      const label = EDITOR_MODE_LABELS[editorMode];
      dwellingMoveToggle.textContent = label;
      dwellingMoveToggle.setAttribute("aria-label", `Switch editor mode (current: ${label})`);
      dwellingMoveToggle.title = `Switch mode (current: ${label})`;
    }
    if (editorModeHelp) editorModeHelp.textContent = EDITOR_MODE_HELP[editorMode];
  }

  function setEditorMode(mode) {
    editorMode = EDITOR_MODES.includes(mode) ? mode : "editing";
    const relocation = isRelocationMode();
    for (const marker of allDwellingMarkers) {
      marker.dragging?.[relocation ? "enable" : "disable"]();
    }
    for (const marker of allSpecialLocationMarkers) {
      marker.dragging?.[relocation ? "enable" : "disable"]();
    }
    if (!isAddingMode()) {
      specialLocationPlacementPending = false;
      if (specialLocationPlaceBtn) specialLocationPlaceBtn.textContent = "New";
    }
    syncEditorModeUi();
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
    const completedStatuses = new Set(["400", "402", "701", "312", "324", "000", "001", "601"]);
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
    const clusterMode = !isRelocationMode() && map.getZoom() < 15;
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
    const currentIndex = EDITOR_MODES.indexOf(editorMode);
    const nextMode = EDITOR_MODES[(currentIndex + 1) % EDITOR_MODES.length];
    setEditorMode(nextMode);
    setStatus(EDITOR_MODE_HELP[nextMode], false);
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
        buildMapActionButtons(point.lat, point.lng, shareTitle, false, getViewerShareUrl()),
        `</div>`
      ].join(""), { autoPan: false });
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
        if (specialLocationPlacementPending) {
          src?.preventDefault?.();
          src?.stopPropagation?.();
          void placeSpecialLocation(event.latlng);
          return;
        }
        if (isAddingMode() && isAddDwellingPointerIntent(src)) {
          src.preventDefault?.();
          src.stopPropagation?.();
          void addDwellingAt(event.latlng, layer);
          return;
        }
        selectZone(layer, { showPopup: true, popupLatLng: event?.latlng || null });
      });
      layer.on("contextmenu", (event) => {
        if (!isAddingMode()) return;
        const src = event?.originalEvent;
        if (specialLocationPlacementPending) {
          src?.preventDefault?.();
          src?.stopPropagation?.();
          return;
        }
        src?.preventDefault?.();
        src?.stopPropagation?.();
        void addDwellingAt(event.latlng, layer);
      });
      layer.on("tap", (event) => {
        if (specialLocationPlacementPending) {
          event?.originalEvent?.preventDefault?.();
          event?.originalEvent?.stopPropagation?.();
          void placeSpecialLocation(event.latlng);
          return;
        }
        selectZone(layer, { showPopup: true, popupLatLng: event?.latlng || null });
      });
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
      buildMapActionButtons(lat, lng, name, false, getViewerShareUrl()),
      `</div>`
    ].join("");
  }

  function attachSpecialLocationPopupHandlers(marker) {
    const html = buildSpecialLocationPopupHtml(marker.feature);
    if (marker.getPopup()) marker.setPopupContent(html);
    else marker.bindPopup(html, { autoPan: true });
  }

  function createSpecialLocationMarker(feature) {
    const coordinates = feature?.geometry?.coordinates || [];
    const lng = Number(coordinates[0]);
    const lat = Number(coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    const marker = L.marker([lat, lng], { icon: specialLocationIcon(feature?.properties?.locationType), keyboard: true, draggable: isRelocationMode() }).addTo(specialLocationsLayer);
    marker.feature = {
      type: "Feature",
      id: feature.id ?? null,
      properties: { ...(feature.properties || {}) },
      geometry: { type: "Point", coordinates: [lng, lat] }
    };
    marker._offlineMutationId = feature._offlineQueueId || null;
    marker._offlineMutationKey = feature._offlineMutationKey || null;
    allSpecialLocationMarkers.add(marker);
    marker.on("click", () => selectSpecialLocationMarker(marker));
    marker.on("dragend", () => {
      if (!isRelocationMode()) return;
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
    if (!isAddingMode()) return;
    const type = String(specialLocationTypeInput?.value || "other");
    const name = String(specialLocationNameInput?.value || "").trim() || type.replaceAll("_", " ");
    const notes = String(specialLocationNotesInput?.value || "").trim();
    const feature = {
      type: "Feature",
      properties: { _group: "special_locations", locationType: type, name, label: name, notes },
      geometry: { type: "Point", coordinates: [Number(latlng.lng), Number(latlng.lat)] }
    };
    const marker = createSpecialLocationMarker(feature);
    if (!marker) {
      setStatus("Could not add special location marker.", true);
      return;
    }
    selectSpecialLocationMarker(marker);
    specialLocationPlacementPending = false;
    specialLocationPlaceBtn.textContent = "New";
    void persistSpecialLocationMarker(marker);
    setStatus(`${name} added on this device; queued for sending.`, false);
  }

  specialLocationPlaceBtn?.addEventListener("click", () => {
    if (!isAddingMode()) return;
    if (selectedDwellingMarker) {
      applyMarkerIcon(selectedDwellingMarker, false);
      selectedDwellingMarker = null;
    }
    clearSelectedSpecialLocation();
    if (specialLocationGroup) specialLocationGroup.open = true;
    specialLocationPlacementPending = !specialLocationPlacementPending;
    specialLocationPlaceBtn.textContent = specialLocationPlacementPending ? "Click Map to Place" : "New";
    setStatus(specialLocationPlacementPending ? "Click or tap the map to place this special location." : "Special location placement cancelled.", false);
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

  function reflectSpecialLocationFormOnMap(marker) {
    if (!marker?.feature) return;
    const props = marker.feature.properties || (marker.feature.properties = {});
    const type = String(specialLocationTypeInput?.value || "other").trim();
    const name = String(specialLocationNameInput?.value || "").trim() || type.replaceAll("_", " ");
    props._group = "special_locations";
    props.locationType = type;
    props.name = name;
    props.label = name;
    props.notes = String(specialLocationNotesInput?.value || "");
    applySpecialLocationMarkerIcon(marker, marker === selectedSpecialLocationMarker);
    attachSpecialLocationPopupHandlers(marker);
  }

  for (const field of [specialLocationTypeInput, specialLocationNameInput, specialLocationNotesInput]) {
    const reflect = () => {
      if (!selectedSpecialLocationMarker) return;
      reflectSpecialLocationFormOnMap(selectedSpecialLocationMarker);
      setStatus("Special-location fields changed. Press Save to queue them.", false);
    };
    field?.addEventListener("input", reflect);
    field?.addEventListener("change", reflect);
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
    const url = id === null ? `/api/cld/${cld}/features` : `/api/cld/${cld}/features/${id}`;
    marker._offlineMutationKey ||= id === null
      ? `special:new:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : `special:${id}`;
    const queued = queueMutation(id === null ? "POST" : "PUT", url, payload, marker._offlineMutationKey);
    marker._offlineMutationId = id === null ? queued.id : null;
    marker.feature = payload;
    applySpecialLocationMarkerIcon(marker, marker === selectedSpecialLocationMarker);
    attachSpecialLocationPopupHandlers(marker);
    setStatus(`${payload.properties.name} queued for sending`, false);
    return true;
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
      discardQueuedMutation(marker._offlineMutationId);
      removeSpecialLocationMarkerLocally(marker);
      setStatus("Unsaved special location removed", false);
      return;
    }
    if (!canPersistEdits) {
      setStatus("Cannot delete special location: API source unavailable.", true);
      return;
    }
    queueMutation("DELETE", `/api/cld/${cld}/features/${id}`, undefined, `special:${id}`);
    removeSpecialLocationMarkerLocally(marker);
    setStatus("Special location removed; queued for sending", false);
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
      buildMapActionButtons(lat, lng, `Dwelling ${code}`, true, getViewerShareUrl()),
      `</div>`,
      `</div>`
    ].join("");
  }

  function attachDwellingPopupHandlers(marker) {
    const html = buildDwellingPopupHtml(marker.feature);
    if (marker.getPopup()) marker.setPopupContent(html);
    else marker.bindPopup(html, { autoPan: true });
    marker.off("popupopen");
    marker.on("popupopen", (event) => {
      const root = event?.popup?.getElement?.();
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
    updateEditorRouteSummary();

  }

  function fillFormFromFeature(feature) {
    const props = feature?.properties || {};
    dwellingFields.cu.value = extractCuCode(props);
    dwellingFields.block.value = extractBlockCode(props);
    dwellingFields.no.value = extractDwellingNo(props);
    dwellingFields.status.value = normalizeDwellingStatus(props.status);
    dwellingFields.notes.value = props.notes || "";
  }

  function reflectDwellingFormOnMap(marker) {
    if (!marker?.feature) return;
    const props = marker.feature.properties || (marker.feature.properties = {});
    props.CUID = String(dwellingFields.cu?.value || "").trim();
    props.CB_COLCODE = String(dwellingFields.block?.value || "").trim();
    props.dwellingNo = String(dwellingFields.no?.value || "").trim();
    props.status = normalizeDwellingStatus(dwellingFields.status?.value);
    props.notes = String(dwellingFields.notes?.value || "");
    applyMarkerIcon(marker, marker === selectedDwellingMarker);
    attachDwellingPopupHandlers(marker);
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
    marker._offlineMutationId = feature._offlineQueueId || null;
    marker._offlineMutationKey = feature._offlineMutationKey || null;
    marker._temporary = temporary;
    allDwellingMarkers.add(marker);
    updateEditorRouteSummary();
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
      if (!isRelocationMode()) return;
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
  setEditorMode("editing");
  updateDwellingSaveAllState();
  updateEditorRouteSummary();

  function replacePointFeatures(nextDwellings, nextSpecialLocations) {
    clearSelectedSpecialLocation();
    selectedDwellingMarker = null;
    dwellingsLayer.clearLayers();
    specialLocationsLayer.clearLayers();
    dwellingClusterLayer.clearLayers();
    allDwellingMarkers.clear();
    allSpecialLocationMarkers.clear();
    dwellingMarkersById.clear();
    specialLocationMarkersById.clear();
    dirtyDwellingMarkers.clear();
    clearDwellingForm();
    for (const feature of nextDwellings) createDwellingMarker(feature);
    for (const feature of nextSpecialLocations) createSpecialLocationMarker(feature);
    setEditorMode(editorMode);
    syncDwellingDisplay();
    updateDwellingSaveAllState();
    updateEditorRouteSummary();
  }

  if (editableLayer.getLayers().length > 0) {
    map.fitBounds(editableLayer.getBounds(), { padding: [20, 20] });
  } else if (dwellingsLayer.getLayers().length > 0) {
    const dwellingBounds = dwellingsLayer.getBounds();
    if (dwellingBounds.isValid()) {
      map.fitBounds(dwellingBounds, { padding: [20, 20] });
    }
  } else {
    setStatus(data.loadError || `No region geometry loaded for CLD ${cld}.`, true);
  }
  mapUrlState.applyRequestedMapView();

  function clearDwellingForm() {
    dwellingFields.cu.value = "";
    dwellingFields.block.value = "";
    dwellingFields.no.value = "";
    dwellingFields.status.value = "429";
    dwellingFields.notes.value = "";
  }

  const offlineQueueKey = `cld-map-pending:${cld}`;
  let offlineQueueFlushInProgress = false;

  function readOfflineQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
      return Array.isArray(queue) ? queue : [];
    } catch {
      return [];
    }
  }

  function queueMutation(method, url, payload, dedupeKey = "") {
    const queue = readOfflineQueue();
    const existing = dedupeKey
      ? queue.findIndex((item) => item.dedupeKey === dedupeKey)
      : queue.findIndex((item) => item.method === method && item.url === url && method === "PUT");
    const item = {
      id: existing >= 0 ? queue[existing].id : `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      method,
      url,
      payload,
      dedupeKey,
      queuedAt: existing >= 0 ? queue[existing].queuedAt : Date.now(),
      revision: existing >= 0 ? Number(queue[existing].revision || 0) + 1 : 1
    };
    if (existing >= 0) queue.splice(existing, 1, item);
    else queue.push(item);
    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
    window.dispatchEvent(new CustomEvent("census-map-local-change", { detail: { cld } }));
    setSyncStatus("Waiting to send", "pending");
    void flushOfflineQueue();
    return item;
  }

  function discardQueuedMutation(mutationId) {
    if (!mutationId) return;
    const queue = readOfflineQueue().filter((item) => item.id !== mutationId);
    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
    window.dispatchEvent(new CustomEvent("census-map-local-change", { detail: { cld } }));
  }

  function applyQueuedCreateResult(item, result) {
    if (item.method !== "POST") return;
    const id = Number(result?.ids?.[0]);
    if (!Number.isFinite(id)) return;
    const isSpecialLocation = item.payload?.properties?._group === "special_locations";
    const markers = isSpecialLocation ? allSpecialLocationMarkers : allDwellingMarkers;
    for (const marker of markers) {
      if (marker._offlineMutationId !== item.id) continue;
      marker.feature.id = id;
      marker._offlineMutationId = null;
      marker._offlineMutationKey = null;
      marker._temporary = false;
      if (isSpecialLocation) {
        specialLocationMarkersById.set(id, marker);
        attachSpecialLocationPopupHandlers(marker);
      } else {
        dwellingMarkersById.set(id, marker);
        clearDwellingDirty(marker);
        attachDwellingPopupHandlers(marker);
      }
      break;
    }
  }

  async function flushOfflineQueue() {
    if (!navigator.onLine || offlineQueueFlushInProgress) return;
    const queue = readOfflineQueue();
    if (queue.length === 0) return;
    offlineQueueFlushInProgress = true;
    setSyncStatus(`Sending ${queue.length} change${queue.length === 1 ? "" : "s"}…`, "pending");
    const remaining = [];
    let queuedDuringFlush = false;
    try {
      for (const item of queue) {
        try {
          const result = await getJsonWithTimeout(item.url, {
            method: item.method,
            headers: { "Content-Type": "application/json" },
            body: item.payload === undefined ? undefined : JSON.stringify(item.payload)
          });
          applyQueuedCreateResult(item, result);
        } catch {
          remaining.push(item);
        }
      }
      // Do not overwrite changes queued while this older snapshot was sent.
      const latestQueue = readOfflineQueue();
      const batchById = new Map(queue.map((item) => [item.id, item]));
      const newerItems = latestQueue.filter((item) => {
        const batchItem = batchById.get(item.id);
        return !batchItem || Number(item.revision || 0) !== Number(batchItem.revision || 0);
      });
      const newerIds = new Set(newerItems.map((item) => item.id));
      const nextQueue = [...remaining.filter((item) => !newerIds.has(item.id)), ...newerItems];
      queuedDuringFlush = newerItems.length > 0;
      localStorage.setItem(offlineQueueKey, JSON.stringify(nextQueue));
      window.dispatchEvent(new CustomEvent("census-map-local-change", { detail: { cld } }));
      setSyncStatus(nextQueue.length ? "Waiting to send" : "Saved", nextQueue.length ? "pending" : "saved");
    } finally {
      offlineQueueFlushInProgress = false;
      if (queuedDuringFlush) void flushOfflineQueue();
    }
  }

  window.addEventListener("online", () => {
    void flushOfflineQueue();
  });
  void flushOfflineQueue();
  window.setInterval(() => {
    void flushOfflineQueue();
  }, 120000);

  async function uploadAndRefresh() {
    if (!navigator.onLine) {
      setStatus("You are offline. Changes remain queued on this device.", true);
      return;
    }
    uploadRefreshBtn.disabled = true;
    setStatus("Uploading changes…", false);
    try {
      await saveAllDirtyDwellings();
      // Wait for an already-running request, then drain every queued batch.
      while (offlineQueueFlushInProgress) await wait(40);
      let attempts = 0;
      while (readOfflineQueue().length > 0 && attempts < 20) {
        await flushOfflineQueue();
        while (offlineQueueFlushInProgress) await wait(40);
        attempts += 1;
      }
      if (readOfflineQueue().length > 0) {
        setStatus("Some changes could not be uploaded. They remain queued.", true);
        return;
      }
      setSyncStatus("Saved", "saved");
      const freshMapData = await getMapData(true);
      if (freshMapData.loadError) throw new Error(freshMapData.loadError);
      replacePointFeatures(freshMapData.dwellings, freshMapData.specialLocations);
      setStatus("Map markers refreshed.", false);
    } catch (error) {
      setStatus(`Could not refresh map: ${error.message}`, true);
    } finally {
      updateUploadRefreshAvailability();
    }
  }

  uploadRefreshBtn?.addEventListener("click", () => {
    void uploadAndRefresh();
  });

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
    if (!isAddingMode()) return;
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

    const url = id === null ? `/api/cld/${cld}/features` : `/api/cld/${cld}/features/${id}`;
    marker._offlineMutationKey ||= id === null
      ? `dwelling:new:${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
      : `dwelling:${id}`;
    const queued = queueMutation(id === null ? "POST" : "PUT", url, payload, marker._offlineMutationKey);
    marker._offlineMutationId = id === null ? queued.id : null;
    marker.feature = payload;
    attachDwellingPopupHandlers(marker);
    updateEditorRouteSummary();
    if (selectAfterSave) {
      selectedDwellingMarker = marker;
      applyMarkerIcon(marker, true);
    } else {
      applyMarkerIcon(marker, false);
    }
    clearDwellingDirty(marker);
    setStatus(`Dwelling ${extractDwellingNo(payload.properties || {})} queued for sending`, false);
    return true;
  }

  dwellingSaveBtn?.addEventListener("click", async () => {
    await persistDwellingMarker(selectedDwellingMarker, { selectAfterSave: true });
  });

  for (const field of Object.values(dwellingFields)) {
    if (!field) continue;
    const eventName = field.type === "checkbox" ? "change" : "input";
    field.addEventListener(eventName, () => {
      if (!selectedDwellingMarker) return;
      reflectDwellingFormOnMap(selectedDwellingMarker);
      if (field === dwellingFields.status) {
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

  async function copySsidsByStatus() {
    const selectedStatus = normalizeDwellingStatus(copySsidStatusInput?.value || "429");
    const ssids = getDwellingBulkRows()
      .filter((row) => row.status === selectedStatus)
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
      setStatus(`${ssids ? ssids.split("\n").length : 0} SSID(s) with status ${selectedStatus} copied.`, false);
    } catch (error) {
      setStatus(`Could not copy SSIDs: ${error.message}`, true);
    }
  }

  dwellingExportBtn?.addEventListener("click", exportDwellingsXls);

  function spreadsheetCell(value) {
    const text = String(value ?? "");
    return /^[=+\-@]/.test(text) ? `'${text}` : text;
  }

  async function exportTodayUpdatesXls() {
    if (!navigator.onLine) {
      setStatus("Connect to the internet to download today's updates.", true);
      return;
    }
    if (!window.XLSX) {
      setStatus("Excel exporter is not available yet. Reload the page and try again.", true);
      return;
    }
    todayUpdatesExportBtn.disabled = true;
    try {
      const result = await getJsonWithTimeout(`/api/cld/${cld}/updates/today`, {}, 15000);
      const rows = [
        ["SSID", "NEW CODE", "NOTE"],
        ...(result.updates || []).map((update) => [
          spreadsheetCell(update.ssid),
          spreadsheetCell(update.newCode),
          spreadsheetCell(update.note)
        ])
      ];
      const workbook = window.XLSX.utils.book_new();
      const worksheet = window.XLSX.utils.aoa_to_sheet(rows);
      worksheet["!cols"] = [{ wch: 18 }, { wch: 12 }, { wch: 60 }];
      window.XLSX.utils.book_append_sheet(workbook, worksheet, "Today's updates");
      const dateParts = new Intl.DateTimeFormat("en-CA", {
        timeZone: result.timezone || "America/Winnipeg",
        year: "numeric",
        month: "2-digit",
        day: "2-digit"
      }).formatToParts(new Date());
      const today = ["year", "month", "day"]
        .map((part) => dateParts.find((entry) => entry.type === part)?.value || "00")
        .join("-");
      window.XLSX.writeFile(workbook, `cld-${cld}-updates-${today}.xls`, { bookType: "xls" });
      setStatus(`${Math.max(rows.length - 1, 0)} update(s) exported for today.`, false);
    } catch (error) {
      setStatus(`Could not export today's updates: ${error.message}`, true);
    } finally {
      todayUpdatesExportBtn.disabled = false;
    }
  }

  todayUpdatesExportBtn?.addEventListener("click", () => {
    void exportTodayUpdatesXls();
  });

  copySsidsBtn?.addEventListener("click", () => {
    void copySsidsByStatus();
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

  async function applyBulkNotesUpdate() {
    if (!canPersistEdits) {
      setStatus("Cannot update notes: API source unavailable.", true);
      return;
    }
    const file = bulkNotesFileInput?.files?.[0];
    if (!file) {
      setStatus("Choose an XLS or XLSX file first.", true);
      return;
    }
    if (!window.XLSX) {
      setStatus("Excel reader is not available yet. Reload the page and try again.", true);
      return;
    }

    let rows;
    try {
      const workbook = window.XLSX.read(await file.arrayBuffer(), { type: "array" });
      const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
      rows = window.XLSX.utils.sheet_to_json(firstSheet, { header: 1, raw: false, defval: "" });
    } catch (error) {
      setStatus(`Could not read spreadsheet: ${error.message}`, true);
      return;
    }

    const notesBySsid = new Map();
    for (const row of rows) {
      const ssid = String(row?.[0] ?? "").replace(/\D/g, "");
      if (!ssid) continue; // Empty rows and a textual header are ignored.
      notesBySsid.set(ssid, String(row?.[1] ?? "").trim());
    }
    if (notesBySsid.size === 0) {
      setStatus("The spreadsheet has no SSID values in its first column.", true);
      return;
    }

    const markersBySsid = new Map(
      [...allDwellingMarkers].map((marker) => {
        const props = marker.feature?.properties || {};
        return [`${extractCuCode(props)}${extractDwellingNo(props)}`, marker];
      })
    );
    const matches = [];
    const missing = [];
    for (const [ssid, note] of notesBySsid) {
      const marker = markersBySsid.get(ssid);
      if (marker) matches.push({ marker, note });
      else missing.push(ssid);
    }
    if (matches.length === 0) {
      setStatus("No SSIDs from the spreadsheet were found in this CLD.", true);
      return;
    }

    bulkNotesApplyBtn.disabled = true;
    setStatus(`Applying notes to ${matches.length} dwelling(s)…`, false);
    let updated = 0;
    let cleared = 0;
    let failed = 0;
    for (const { marker, note } of matches) {
      const currentNotes = String(marker.feature?.properties?.notes || "").trim();
      const nextNotes = note ? [currentNotes, note].filter(Boolean).join("\n") : "";
      if (nextNotes === currentNotes) continue;
      marker.feature.properties.notes = nextNotes;
      if (marker === selectedDwellingMarker && dwellingFields.notes) {
        dwellingFields.notes.value = nextNotes;
      }
      markDwellingDirty(marker);
      const saved = await persistDwellingMarker(marker, {
        selectAfterSave: marker === selectedDwellingMarker,
        useMarkerProperties: true
      });
      if (saved) {
        updated += 1;
        if (!note) cleared += 1;
      } else {
        failed += 1;
      }
    }
    bulkNotesApplyBtn.disabled = false;
    const summary = `${updated} updated${cleared ? `, ${cleared} cleared` : ""}${missing.length ? `, ${missing.length} SSID(s) not found` : ""}`;
    setStatus(failed ? `Bulk notes finished: ${summary}, ${failed} failed.` : `Bulk notes queued: ${summary}.`, failed > 0);
  }

  bulkNotesApplyBtn?.addEventListener("click", () => {
    void applyBulkNotesUpdate();
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

  let lastDwellingAddGesture = null;

  function addDwellingAt(latlng, preferredZoneLayer = null) {
    if (!isAddingMode()) return;
    if (!canPersistEdits) {
      setStatus("Cannot add dwelling: API source unavailable.", true);
      return;
    }

    const zoneLayer = preferredZoneLayer && getZoneKind(preferredZoneLayer.feature?.properties || {}) === "block"
      ? preferredZoneLayer
      : resolveZoneForDwellingAdd(latlng);
    if (!zoneLayer || getZoneKind(zoneLayer.feature?.properties || {}) !== "block") {
      setStatus("Use right-click, Ctrl/Cmd+click, or a long tap inside a block polygon to create a dwelling.", true);
      return;
    }

    const now = Date.now();
    const isDuplicateGesture = lastDwellingAddGesture
      && now - lastDwellingAddGesture.at < 250
      && Math.abs(latlng.lat - lastDwellingAddGesture.lat) < 0.000001
      && Math.abs(latlng.lng - lastDwellingAddGesture.lng) < 0.000001;
    if (isDuplicateGesture) return;
    lastDwellingAddGesture = { at: now, lat: latlng.lat, lng: latlng.lng };

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

    void persistDwellingMarker(marker, { selectAfterSave: true });
    map.flyTo(latlng, Math.max(map.getZoom(), 18), { duration: 0.35 });
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
    if (!isAddingMode() || !isAddDwellingPointerIntent(src)) return;
    if (src?.target?.closest?.("#editor-panel, #map-ui, .leaflet-marker-icon, .leaflet-popup")) return;
    src.preventDefault?.();
    src.stopPropagation?.();
    void addDwellingAt(event.latlng, null);
  });

  map.on("contextmenu", (event) => {
    const src = event?.originalEvent;
    if (!isAddingMode()) return;
    if (src?.target?.closest?.("#editor-panel, #map-ui")) return;
    src.preventDefault?.();
    src.stopPropagation?.();
    if (specialLocationPlacementPending) {
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
      discardQueuedMutation(selectedDwellingMarker._offlineMutationId);
      removeDwellingMarkerLocally(selectedDwellingMarker);
      setStatus("Unsaved dwelling removed", false);
      return;
    }

    if (!canPersistEdits) {
      setStatus("Cannot delete dwelling: API source unavailable.", true);
      return;
    }

    queueMutation("DELETE", `/api/cld/${cld}/features/${id}`, undefined, `dwelling:${id}`);
    removeDwellingMarkerLocally(selectedDwellingMarker);
    setStatus("Dwelling removed; queued for sending", false);
  });

  collapseBtn?.addEventListener("click", () => {
    if (!formWrap) return;
    const collapsed = formWrap.classList.toggle("collapsed");
    collapseBtn.setAttribute("aria-expanded", String(!collapsed));
    collapseBtn.textContent = collapsed ? "Dwellings Editor" : "Dwellings Editor";
  });

  await userLocationTracker.start();
  window.addEventListener("beforeunload", () => userLocationTracker.stop());
})();
