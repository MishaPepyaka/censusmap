(async function initStatcanViewer() {
  const { getJson } = window.CensusMapApi;
  const { buildMapActionButtons } = window.CensusMapActions;
  const { createDwellingSearchIndex } = window.CensusMapDwellingSearch;
  const { escapeHtml, extractBlockCode, extractCuCode, extractDwellingNo, getZoneKind, isDwellingFeature, isZoneFeature } = window.CensusMapData;
  const searchInput = document.getElementById("dwelling-search-input");
  const searchBtn = document.getElementById("dwelling-search-btn");
  const searchStatus = document.getElementById("dwelling-search-status");

  const dwellingSearchIndex = createDwellingSearchIndex();
  const dwellingsByKey = new Map();

  function setStatus(message, isError) {
    if (!searchStatus) return;
    searchStatus.textContent = message || "";
    searchStatus.classList.toggle("search-status-error", Boolean(isError));
  }

  function dwellingIcon(no, selected) {
    return L.divIcon({
      className: "dwelling-marker-wrap",
      html: `<span class="dwelling-marker ${selected ? "selected" : ""}">${escapeHtml(no)}</span>`,
      iconSize: [24, 24],
      iconAnchor: [12, 12]
    });
  }

  function addToIndex(record) {
    dwellingSearchIndex.add(record);
  }

  function parseFeatures(payload) {
    const features = Array.isArray(payload?.features)
      ? payload.features
      : Array.isArray(payload)
        ? payload
        : [];
    return {
      cuBoundaries: features.filter((f) => isZoneFeature(f) && getZoneKind(f.properties || {}) === "cu"),
      dwellings: features.filter((f) => isDwellingFeature(f.properties || {}, f.geometry || {}))
    };
  }

  async function loadMapData() {
    try {
      const apiData = await getJson("/api/features");
      return { source: "api", ...parseFeatures(apiData) };
    } catch (apiError) {
      const localCandidates = [];

      try {
        const fileStoreData = await getJson("./file-store.json");
        localCandidates.push({ source: "file-store", parsed: parseFeatures(fileStoreData) });
      } catch {
        // no-op
      }

      try {
        const featuresData = await getJson("./features.geojson");
        localCandidates.push({ source: "features", parsed: parseFeatures(featuresData) });
      } catch {
        // no-op
      }

      try {
        const blocksData = await getJson("./blocks.geojson");
        localCandidates.push({ source: "blocks", parsed: parseFeatures(blocksData) });
      } catch {
        // no-op
      }

      if (localCandidates.length === 0) {
        throw new Error(`API failed (${apiError.message}) and no local fallback found`);
      }

      const bestBoundaries = localCandidates.reduce((acc, item) =>
        item.parsed.cuBoundaries.length > acc.parsed.cuBoundaries.length ? item : acc
      );
      const bestDwellings = localCandidates.reduce((acc, item) =>
        item.parsed.dwellings.length > acc.parsed.dwellings.length ? item : acc
      );

      return {
        source: "local",
        cuBoundaries: bestBoundaries.parsed.cuBoundaries,
        dwellings: bestDwellings.parsed.dwellings
      };
    }
  }

  const map = L.map("map", {
    preferCanvas: false,
    zoomControl: true,
    tap: true,
    markerZoomAnimation: true
  }).setView([56.0, -96.0], 5);
  map.getContainer().style.background = "#9C9C9C";

  const data = await loadMapData();

  if (data.source !== "api") {
    setStatus("Local fallback data loaded", false);
  }

  const cuLayer = L.geoJSON(
    { type: "FeatureCollection", features: data.cuBoundaries },
    {
      style: () => ({
        color: "#22d3ee",
        weight: 2.4,
        opacity: 0.95,
        fillOpacity: 0
      })
    }
  ).addTo(map);

  const dwellingsLayer = L.layerGroup().addTo(map);
  let selectedMarker = null;

  function setSelectedMarker(marker) {
    if (selectedMarker && selectedMarker !== marker) {
      const prevNo = selectedMarker.__info?.no || "0000";
      selectedMarker.setIcon(dwellingIcon(prevNo, false));
    }
    selectedMarker = marker;
    if (selectedMarker) {
      const currentNo = selectedMarker.__info?.no || "0000";
      selectedMarker.setIcon(dwellingIcon(currentNo, true));
    }
  }

  function focusRecord(record, updateStatus) {
    const marker = dwellingsByKey.get(record.key) || null;
    if (!marker) return;
    map.flyTo(marker.getLatLng(), Math.max(map.getZoom(), 18), { duration: 0.45 });
    setSelectedMarker(marker);
    marker.openPopup();
    if (updateStatus) {
      setStatus(`Found: ${record.code}`, false);
    }
  }

  function findRecordByQuery(value) {
    return dwellingSearchIndex.find(value, "462210550033");
  }

  function onSearch() {
    const result = findRecordByQuery(searchInput?.value || "");
    if (!result.record) {
      setStatus(result.message, true);
      return;
    }
    focusRecord(result.record, false);
    setStatus(result.message || "Found", false);
  }

  let rendered = 0;
  for (let i = 0; i < data.dwellings.length; i += 1) {
    const feature = data.dwellings[i];
    const props = feature?.properties || {};
    const geom = feature?.geometry || {};
    if (geom.type !== "Point" || !Array.isArray(geom.coordinates) || geom.coordinates.length < 2) continue;

    const lng = Number(geom.coordinates[0]);
    const lat = Number(geom.coordinates[1]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;

    const cu = extractCuCode(props);
    const block = extractBlockCode(props);
    const no = extractDwellingNo(props);
    const code = `${cu}${no}`;
    const key = `${cu}:${block}:${no}:${lat.toFixed(6)}:${lng.toFixed(6)}:${i}`;
    const record = { key, cu, block, no, code, lat, lng };

    addToIndex(record);

    const marker = L.marker([lat, lng], {
      icon: dwellingIcon(no, false),
      keyboard: true
    }).addTo(dwellingsLayer);
    marker.__info = record;
    marker.bindPopup(
      [
        `<div class="dw-popup">`,
        `<div class="dw-popup-code">${escapeHtml(code)}</div>`,
        `<div class="dw-popup-meta">CU ${escapeHtml(cu)} · Block ${escapeHtml(block)} · Dwelling ${escapeHtml(no)}</div>`,
        buildMapActionButtons(lat, lng, `Dwelling ${code}`, true),
        `</div>`
      ].join(""),
      { autoPan: true }
    );
    marker.on("click", () => setSelectedMarker(marker));

    dwellingsByKey.set(key, marker);
    rendered += 1;
  }

  searchBtn?.addEventListener("click", onSearch);
  searchInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      onSearch();
    }
  });

  if (cuLayer.getLayers().length > 0) {
    map.fitBounds(cuLayer.getBounds(), { padding: [18, 18] });
  } else if (rendered > 0) {
    const bounds = L.latLngBounds([...dwellingsByKey.values()].map((m) => m.getLatLng()));
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [18, 18] });
    }
  }
})();
