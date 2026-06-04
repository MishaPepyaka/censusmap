(async function initStatcanViewer() {
  const searchInput = document.getElementById("dwelling-search-input");
  const searchBtn = document.getElementById("dwelling-search-btn");
  const searchStatus = document.getElementById("dwelling-search-status");

  const dwellingsByCode = new Map();
  const dwellingsByCu = new Map();
  const dwellingsByNo = new Map();
  const dwellingsByKey = new Map();

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

  function normalizeSearchCode(value) {
    return String(value || "").replace(/\D/g, "");
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
    return fromName && fromName.trim().length > 0 ? fromName.trim().padStart(2, "0") : "??";
  }

  function extractDwellingNo(props) {
    const raw = props.dwellingNo ?? props.DWELLING_NO ?? props.vrNumber ?? props.VR_NUMBER;
    if (!isNonEmpty(raw)) return "0000";
    return String(raw).trim().replace(/\D/g, "").padStart(4, "0").slice(-4);
  }

  function isDwellingFeature(props, geometry) {
    if (!props || typeof props !== "object") return false;
    if (String(props._group || "").toLowerCase() === "dwellings") return true;
    if (isNonEmpty(props.dwellingNo) || isNonEmpty(props.DWELLING_NO) || isNonEmpty(props.vrNumber) || isNonEmpty(props.VR_NUMBER)) {
      return geometry?.type === "Point";
    }
    return false;
  }

  function isCuBoundaryFeature(props, geometry) {
    if (!props || typeof props !== "object") return false;
    const t = geometry?.type;
    const isArea = t === "Polygon" || t === "MultiPolygon";
    if (!isArea) return false;
    if (String(props._group || "").toLowerCase() === "cu") return true;
    if (isNonEmpty(props.CUID) && !isNonEmpty(props.COLB_UID) && !isNonEmpty(props.CB_COLCODE)) return true;
    return false;
  }

  function setStatus(message, isError) {
    if (!searchStatus) return;
    searchStatus.textContent = message || "";
    searchStatus.classList.toggle("search-status-error", Boolean(isError));
  }

  function getGoogleMapsLink(lat, lng) {
    return `https://www.google.com/maps?q=${lat.toFixed(6)},${lng.toFixed(6)}`;
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
    if (!dwellingsByCode.has(record.code)) dwellingsByCode.set(record.code, []);
    dwellingsByCode.get(record.code).push(record);
    if (!dwellingsByCu.has(record.cu)) dwellingsByCu.set(record.cu, []);
    dwellingsByCu.get(record.cu).push(record);
    if (!dwellingsByNo.has(record.no)) dwellingsByNo.set(record.no, []);
    dwellingsByNo.get(record.no).push(record);
  }

  async function getJson(url) {
    const response = await fetch(url);
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload.error || payload.message || "Request failed");
    }
    return payload;
  }

  function parseFeatures(payload) {
    const features = Array.isArray(payload?.features)
      ? payload.features
      : Array.isArray(payload)
        ? payload
        : [];
    return {
      cuBoundaries: features.filter((f) => isCuBoundaryFeature(f.properties || {}, f.geometry || {})),
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
    const digits = normalizeSearchCode(value);
    if (!digits) return { record: null, message: "Enter code like 462210550033", error: true };

    if (digits.length >= 12) {
      const cu = digits.slice(0, 8);
      const no = digits.slice(-4);
      const code = `${cu}${no}`;
      const list = dwellingsByCode.get(code) || [];
      return list.length > 0
        ? { record: list[0], message: "", error: false }
        : { record: null, message: `Not found: ${code}`, error: true };
    }

    if (digits.length === 8) {
      const list = dwellingsByCu.get(digits) || [];
      if (list.length === 0) return { record: null, message: `No dwellings in CU ${digits}`, error: true };
      return { record: list[0], message: `CU ${digits}: showing first dwelling`, error: false };
    }

    if (digits.length <= 4) {
      const no = digits.padStart(4, "0");
      const list = dwellingsByNo.get(no) || [];
      if (list.length === 0) return { record: null, message: `No dwelling ${no}`, error: true };
      if (list.length > 1) return { record: list[0], message: `Multiple ${no}, showing first match`, error: false };
      return { record: list[0], message: "", error: false };
    }

    return { record: null, message: "Use 4, 8, or 12+ digits", error: true };
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
    const gmapsUrl = getGoogleMapsLink(lat, lng);
    const key = `${cu}:${block}:${no}:${lat.toFixed(6)}:${lng.toFixed(6)}:${i}`;
    const record = { key, cu, block, no, code, lat, lng, gmapsUrl };

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
        `<div class="dw-popup-actions">`,
        `<a class="dw-action-btn dw-action-open" href="${escapeHtml(gmapsUrl)}" target="_blank" rel="noreferrer">Open Google Maps</a>`,
        `</div>`,
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
