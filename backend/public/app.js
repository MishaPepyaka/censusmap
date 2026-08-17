(async function initViewer() {
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
  const { getGoogleMapsLink, buildMapActionButtons } = window.CensusMapActions;
  const { readMapUrlState, bindMapUrlState, setupBaseMap, setupTileCacheStatus, createUserLocationTracker } = window.CensusMapRuntime;
  const routeMatch = window.location.pathname.match(/^\/(\d+)(?:\/)?$/);
  const cld = routeMatch ? routeMatch[1] : "";
  if (!cld) {
    window.location.replace("/");
    return;
  }
  const requestedMapView = readMapUrlState();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // The viewer still works online if a browser disallows service workers.
    });
  }

  let selectedPolygonLayer = null;
  let selectedDwellingMarker = null;
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
  const uploadRefreshBtn = document.getElementById("upload-refresh-btn");
  const locateBtn = document.getElementById("locate-btn");
  const baseMapBtn = document.getElementById("basemap-btn");
  const searchInput = document.getElementById("dwelling-search-input");
  const searchBtn = document.getElementById("dwelling-search-btn");
  const searchStatus = document.getElementById("dwelling-search-status");
  const tileCacheStatus = document.getElementById("tile-cache-status");
  let currentUser = null;

  function updateUploadRefreshAvailability() {
    if (!uploadRefreshBtn) return;
    uploadRefreshBtn.disabled = !navigator.onLine;
    uploadRefreshBtn.title = navigator.onLine ? "Download current map changes" : "Unavailable while offline";
  }
  updateUploadRefreshAvailability();
  window.addEventListener("online", updateUploadRefreshAvailability);
  window.addEventListener("offline", updateUploadRefreshAvailability);

  async function loadCurrentUser() {
    if (!navigator.onLine) return;
    try {
      const payload = await getJsonWithTimeout("/api/me");
      currentUser = payload.user || null;
    } catch {
      currentUser = null;
    }
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
    return ["429", "400", "402", "701", "500", "312", "324", "000", "001", "601"].includes(status) ? status : "429";
  }

  function formatSsidDisplay(value) {
    const digits = String(value || "").replace(/\D/g, "");
    if (digits.length !== 8) return String(value || "").trim();
    return `${digits.slice(0, 2)} ${digits.slice(2, 4)} ${digits.slice(4)}`;
  }

  function parseFeatures(payload) {
    const features = Array.isArray(payload?.features) ? payload.features : [];
    return {
      zones: features.filter((feature) => isZoneFeature(feature)),
      dwellings: features.filter((feature) => isDwellingFeature(feature.properties || {}, feature.geometry || {})),
      specialLocations: features.filter((feature) => isSpecialLocationFeature(feature.properties || {}, feature.geometry || {}))
    };
  }

  // Edits are queued locally before they reach the server.  The viewer must
  // render that queue too, otherwise opening it immediately after an edit
  // shows the old server copy of the map.
  function getFeatureId(feature) {
    return feature?.id ?? feature?.properties?._id ?? null;
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
      // A malformed local queue must not prevent the map from opening.
    }
    return nextFeatures;
  }

  function buildFeatureCollection(features) {
    return {
      type: "FeatureCollection",
      features: Array.isArray(features) ? features : []
    };
  }

  async function loadRegionSummary() {
    if (!navigator.onLine) {
      return {
        cld,
        label: `CLD ${cld}`,
        ssids: [],
        counts: { cu: 0, blocks: 0, dwellings: 0 },
        loadError: "Offline"
      };
    }
    try {
      return await getJsonWithTimeout(`/api/cld/${cld}`);
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

  async function getMapData(forceNetwork = false) {
    try {
      if (!navigator.onLine) throw new Error("Offline");
      const apiData = await getJsonWithTimeout(`/api/cld/${cld}/features${forceNetwork ? `?refresh=${Date.now()}` : ""}`, {}, 15000);
      const serverFeatures = Array.isArray(apiData.features) ? apiData.features : [];
      const features = applyPendingMutations(serverFeatures);
      if (features.length === 0) throw new Error("The map server returned an empty feature list");
      // Never let a transient empty response replace a usable offline map.
      if (serverFeatures.length > 0) window.CldOfflineStore?.saveCachedFeatures(cld, serverFeatures);
      return { ...parseFeatures({ features }), loadError: "" };
    } catch (error) {
      const snapshot = await window.CldOfflineStore?.readCachedFeatures(cld);
      if (Array.isArray(snapshot?.features) && snapshot.features.length > 0) {
        return {
          ...parseFeatures({ features: applyPendingMutations(snapshot.features) }),
          loadError: "Offline: showing the last map saved on this device."
        };
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

  const mapUrlState = bindMapUrlState(map, requestedMapView, (query) => {
    if (editRouteLink) editRouteLink.href = `/${cld}/edit?${query}`;
  });
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

  const baseMap = setupBaseMap(map, baseMapBtn);
  setupTileCacheStatus(tileCacheStatus, [baseMap.satelliteLayer, baseMap.schematicLayer]);
  const userLocationTracker = createUserLocationTracker(map);

  if (locateBtn) {
    locateBtn.textContent = "🧍";
    locateBtn.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await userLocationTracker.focus();
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

  function bindPolygonInteractions() {
    polygonLayer.eachLayer((layer) => {
      layer.on("click", (event) => selectZone(layer, event?.latlng || null));
      layer.on("tap", (event) => selectZone(layer, event?.latlng || null));
    });
  }
  bindPolygonInteractions();
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
    const statusOptions = ["429", "400", "402", "701", "500", "312", "324", "000", "001", "601"]
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
  }

  const DWELLINGS_MIN_VISIBLE_ZOOM = 10;
  const DWELLINGS_INDIVIDUAL_ZOOM = 15;

  function dwellingClusterLabel(records) {
    const numbers = records.map((record) => Number(record.no)).filter(Number.isFinite).sort((a, b) => a - b);
    if (numbers.length === 0) return String(records.length);
    return numbers[0] === numbers[numbers.length - 1] ? String(numbers[0]) : `${numbers[0]}–${numbers[numbers.length - 1]}`;
  }

  function isCompletedDwellingCluster(records) {
    const completedStatuses = new Set(["400", "402", "701", "312", "324", "000", "001", "601"]);
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

  function replacePointFeatures(nextDwellings, nextSpecialLocations) {
    dwellingsLayer.clearLayers();
    dwellingClusterLayer.clearLayers();
    specialLocationsLayer.clearLayers();
    dwellingByCode.clear();
    dwellingByCu.clear();
    dwellingByNo.clear();
    dwellingRecords.length = 0;
    dwellingMarkerByKey.clear();
    selectedDwellingMarker = null;
    lastDwellingSearchValue = null;
    dwellingSearchMatchIndex = 0;
    for (let index = 0; index < nextDwellings.length; index += 1) {
      const record = buildDwellingRecord(nextDwellings[index], index);
      if (!record) continue;
      dwellingRecords.push(record);
      registerDwellingRecord(record);
    }
    for (const feature of nextSpecialLocations) createSpecialLocationMarker(feature);
    syncSpecialLocationVisibility();
    renderVisibleDwellingMarkers();
  }

  function replaceZoneFeatures(nextZones) {
    selectedPolygonLayer = null;
    polygonLayer.clearLayers();
    polygonLayer.addData(buildFeatureCollection(nextZones));
    bindPolygonInteractions();
    redrawPolygonLayers();
  }

  let localChangeRefreshTimer = null;
  function refreshLocalChanges() {
    window.clearTimeout(localChangeRefreshTimer);
    localChangeRefreshTimer = window.setTimeout(async () => {
      const freshMapData = await getMapData(false);
      const hasMapData = freshMapData.zones.length + freshMapData.dwellings.length + freshMapData.specialLocations.length > 0;
      if (!hasMapData) return;
      replaceZoneFeatures(freshMapData.zones);
      replacePointFeatures(freshMapData.dwellings, freshMapData.specialLocations);
      updateRouteSubtitle();
      setSearchStatus("Local map changes displayed.", false);
    }, 80);
  }

  // The storage event covers edits made in another tab.  The custom event is
  // useful for code running in this same document.
  window.addEventListener("storage", (event) => {
    if (event.key === `cld-map-pending:${cld}`) refreshLocalChanges();
  });
  window.addEventListener("census-map-local-change", (event) => {
    if (String(event.detail?.cld || "") === String(cld)) refreshLocalChanges();
  });

  uploadRefreshBtn?.addEventListener("click", async () => {
    if (!navigator.onLine) return;
    uploadRefreshBtn.disabled = true;
    uploadRefreshBtn.textContent = "Refreshing…";
    try {
      const freshMapData = await getMapData(true);
      if (freshMapData.loadError) throw new Error(freshMapData.loadError);
      replacePointFeatures(freshMapData.dwellings, freshMapData.specialLocations);
      updateRouteSubtitle();
      setSearchStatus("Map markers refreshed.", false);
    } catch (error) {
      setSearchStatus(`Could not refresh map: ${error.message}`, true);
    } finally {
      uploadRefreshBtn.textContent = "Upload and refresh";
      updateUploadRefreshAvailability();
    }
  });

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
    setSearchStatus(
      mapData.loadError || "No geometry or dwellings found for this CLD.",
      true
    );
  }
  mapUrlState.applyRequestedMapView();

  await userLocationTracker.start();
  window.addEventListener("beforeunload", () => userLocationTracker.stop());
})();
