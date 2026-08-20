// @ts-nocheck

(async function initGeometryEditor() {
  const { getJson } = window.CensusMapApi;
  const { isPolygonGeometry, getZoneKind, isHiddenBlock } = window.CensusMapData;
  const match = window.location.pathname.match(/^\/(\d+)\/edit_geometry\/?$/);
  const cld = match ? match[1] : "";
  if (!cld) return window.location.replace("/");

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/sw.js").catch(() => {
      // Geometry editing remains available online if a browser blocks service workers.
    });
  }

  const status = document.getElementById("geometry-status");
  const saveButton = document.getElementById("geometry-save-btn");
  const visibilityButton = document.getElementById("geometry-visibility-btn");
  document.getElementById("geometry-route-label").textContent = `CLD ${cld} geometry editor`;
  document.getElementById("geometry-back-link").href = `/${cld}/edit`;
  document.getElementById("geometry-view-link").href = `/${cld}`;

  function setStatus(message, state = "saved") {
    status.textContent = message;
    status.classList.toggle("pending", state === "pending");
    status.classList.toggle("error", state === "error");
  }

  const map = L.map("map", { zoomControl: false }).setView([56, -96], 4);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("/tiles/satellite/{z}/{y}/{x}", {
    maxZoom: 22, maxNativeZoom: 17, attribution: "Tiles © Esri"
  }).addTo(map);

  const zones = L.featureGroup().addTo(map);
  const handles = L.layerGroup().addTo(map);
  const dirty = new Set();
  let selected = null;
  const offlineQueueKey = `cld-map-pending:${cld}`;
  let regionRevision = 1;

  function readQueue() {
    try {
      const queue = JSON.parse(localStorage.getItem(offlineQueueKey) || "[]");
      return Array.isArray(queue) ? queue : [];
    } catch {
      return [];
    }
  }

  function writeQueue(queue) {
    localStorage.setItem(offlineQueueKey, JSON.stringify(queue));
    void window.CldOfflineStore?.savePendingMutations(cld, queue);
    window.dispatchEvent(new CustomEvent("census-map-local-change", { detail: { cld } }));
  }

  function queueGeometryChange(id, payload) {
    const queue = readQueue();
    const dedupeKey = `geometry:${id}`;
    const index = queue.findIndex((item) => item.dedupeKey === dedupeKey);
    const previous = index >= 0 ? queue[index] : null;
    const item = {
      id: previous?.id || `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      method: "PUT",
      url: `/api/cld/${cld}/features/${id}`,
      payload,
      dedupeKey,
      baseRevision: index >= 0 ? Number(previous.baseRevision || regionRevision) : regionRevision,
      queuedAt: previous?.queuedAt || Date.now(),
      revision: Number(previous?.revision || 0) + 1
    };
    if (index >= 0) queue.splice(index, 1, item);
    else queue.push(item);
    writeQueue(queue);
    return item;
  }

  async function flushGeometryQueue() {
    if (!navigator.onLine) return;
    for (const item of readQueue().filter((entry) => String(entry.dedupeKey || "").startsWith("geometry:"))) {
      try {
        const result = await getJson(item.url, {
          method: "PUT",
          headers: { "Content-Type": "application/json", "If-Match": `\"${item.baseRevision}\"` },
          body: JSON.stringify(item.payload)
        });
        if (Number.isFinite(Number(result?.revision))) regionRevision = Number(result.revision);
        const queue = readQueue();
        const index = queue.findIndex((entry) => entry.id === item.id && Number(entry.revision) === Number(item.revision));
        if (index >= 0) {
          queue.splice(index, 1);
          writeQueue(queue);
        }
      } catch {
        // The queued geometry stays on this device until connectivity returns.
      }
    }
  }

  function zoneName(feature) {
    const props = feature.properties || {};
    return props.CB_COLCODE ? `Block ${String(props.CB_COLCODE).padStart(2, "0")}` : `CU ${props.CUID || props.cu || ""}`;
  }

  function style(layer, active) {
    const hidden = isHiddenBlock(layer?.feature?.properties || {});
    return {
      color: active ? "#facc15" : "#38bdf8",
      weight: active ? 4 : 2,
      fillColor: "#0ea5e9",
      fillOpacity: active ? .16 : (hidden ? .025 : .07),
      dashArray: hidden ? "4 6" : null
    };
  }

  function isBlockLayer(layer) {
    return getZoneKind(layer?.feature?.properties || {}) === "block";
  }

  function syncVisibilityButton() {
    if (!visibilityButton) return;
    const isBlock = isBlockLayer(selected);
    visibilityButton.disabled = !isBlock;
    if (!isBlock) {
      visibilityButton.textContent = "Hide block";
      return;
    }
    visibilityButton.textContent = isHiddenBlock(selected.feature.properties || {}) ? "Show block" : "Hide block";
  }

  function walkRings(value, path = [], out = []) {
    if (!Array.isArray(value)) return out;
    if (value.length > 0 && value[0] instanceof L.LatLng) {
      out.push({ ring: value, path });
      return out;
    }
    value.forEach((child, index) => walkRings(child, [...path, index], out));
    return out;
  }

  function valueAtPath(root, path) {
    return path.reduce((value, index) => value[index], root);
  }

  function clearHandles() { handles.clearLayers(); }

  function showHandles(layer) {
    clearHandles();
    walkRings(layer.getLatLngs()).forEach(({ ring, path }) => {
      ring.forEach((latlng, index) => {
        L.circleMarker(latlng, { radius: 6, color: "#0f172a", weight: 2, fillColor: "#fff", fillOpacity: 1, interactive: true })
          .on("mousedown", (event) => event.originalEvent.stopPropagation())
          .on("click", (event) => event.originalEvent.stopPropagation())
          .addTo(handles)
          .dragging?.disable?.();
        const handle = L.marker(latlng, { draggable: true, icon: L.divIcon({ className: "", html: "", iconSize: [14, 14], iconAnchor: [7, 7] }) }).addTo(handles);
        handle.on("drag", () => {
          const points = valueAtPath(layer.getLatLngs(), path);
          points[index] = handle.getLatLng();
          if (index === 0 && points.length > 1) points[points.length - 1] = handle.getLatLng();
          if (index === points.length - 1 && points.length > 1) points[0] = handle.getLatLng();
          layer.setLatLngs(layer.getLatLngs());
          dirty.add(layer);
          saveButton.disabled = false;
          setStatus(`${dirty.size} boundary change${dirty.size === 1 ? "" : "s"} pending`, "pending");
        });
      });
    });
  }

  function selectLayer(layer) {
    if (selected && selected !== layer) selected.setStyle(style(selected, false));
    selected = layer;
    layer.setStyle(style(layer, true));
    showHandles(layer);
    syncVisibilityButton();
    const hiddenMessage = isHiddenBlock(layer.feature?.properties || {}) ? " (hidden on maps)" : "";
    setStatus(`${zoneName(layer.feature)} selected${hiddenMessage}`);
  }

  await window.CldOfflineStore?.hydratePendingMutations(cld);
  try {
    const data = await getJson(`/api/cld/${cld}/features`);
    if (Number.isFinite(Number(data.revision))) regionRevision = Number(data.revision);
    for (const feature of data.features || []) {
      if (!isPolygonGeometry(feature?.geometry)) continue;
      const geo = L.geoJSON(feature, { style: () => style({ feature }, false) });
      geo.eachLayer((layer) => {
        layer.feature = feature;
        layer.on("click", () => selectLayer(layer));
        zones.addLayer(layer);
      });
    }
    if (zones.getLayers().length) map.fitBounds(zones.getBounds(), { padding: [24, 24] });
    else setStatus("No editable CU or block geometry in this CLD.", "error");
  } catch (error) {
    setStatus(`Could not load geometry: ${error.message}`, "error");
  }

  saveButton.addEventListener("click", async () => {
    const changed = [...dirty];
    if (!changed.length) return;
    saveButton.disabled = true;
    setStatus(`Saving ${changed.length} boundary change${changed.length === 1 ? "" : "s"}…`, "pending");
    try {
      for (const layer of changed) {
        const id = Number(layer.feature?.id);
        if (!Number.isFinite(id)) throw new Error("A boundary is missing its feature id");
        const payload = { type: "Feature", id, properties: layer.feature.properties || {}, geometry: layer.toGeoJSON().geometry };
        queueGeometryChange(id, payload);
        layer.feature.geometry = payload.geometry;
        dirty.delete(layer);
      }
      await flushGeometryQueue();
      setStatus(readQueue().some((item) => String(item.dedupeKey || "").startsWith("geometry:")) ? "Geometry changes queued for sending" : "Geometry saved");
    } catch (error) {
      setStatus(`Geometry save failed: ${error.message}`, "error");
    } finally {
      saveButton.disabled = dirty.size === 0;
    }
  });

  visibilityButton?.addEventListener("click", () => {
    if (!isBlockLayer(selected)) return;
    const props = selected.feature.properties || {};
    const willHide = !isHiddenBlock(props);
    if (willHide) props.hidden = true;
    else delete props.hidden;
    selected.feature.properties = props;
    selected.setStyle(style(selected, true));
    dirty.add(selected);
    saveButton.disabled = false;
    syncVisibilityButton();
    setStatus(`${zoneName(selected.feature)} will be ${willHide ? "hidden" : "shown"} on the viewer and editor after saving.`, "pending");
  });
})();
