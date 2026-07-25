(async function initGeometryEditor() {
  const match = window.location.pathname.match(/^\/(\d+)\/edit_geometry\/?$/);
  const cld = match ? match[1] : "";
  if (!cld) return window.location.replace("/");

  const status = document.getElementById("geometry-status");
  const saveButton = document.getElementById("geometry-save-btn");
  document.getElementById("geometry-route-label").textContent = `CLD ${cld} geometry editor`;
  document.getElementById("geometry-back-link").href = `/${cld}/edit`;
  document.getElementById("geometry-view-link").href = `/${cld}`;

  function setStatus(message, state = "saved") {
    status.textContent = message;
    status.classList.toggle("pending", state === "pending");
    status.classList.toggle("error", state === "error");
  }

  async function getJson(url, options) {
    const response = await fetch(url, options);
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || "Request failed");
    return payload;
  }

  const map = L.map("map", { zoomControl: false }).setView([56, -96], 4);
  L.control.zoom({ position: "bottomright" }).addTo(map);
  L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}", {
    maxZoom: 22, maxNativeZoom: 17, attribution: "Tiles © Esri"
  }).addTo(map);

  const zones = L.featureGroup().addTo(map);
  const handles = L.layerGroup().addTo(map);
  const dirty = new Set();
  let selected = null;

  function isPolygon(feature) {
    return feature?.geometry?.type === "Polygon" || feature?.geometry?.type === "MultiPolygon";
  }

  function zoneName(feature) {
    const props = feature.properties || {};
    return props.CB_COLCODE ? `Block ${String(props.CB_COLCODE).padStart(2, "0")}` : `CU ${props.CUID || props.cu || ""}`;
  }

  function style(layer, active) {
    return { color: active ? "#facc15" : "#38bdf8", weight: active ? 4 : 2, fillColor: "#0ea5e9", fillOpacity: active ? .16 : .07 };
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
    setStatus(`${zoneName(layer.feature)} selected`);
  }

  try {
    const data = await getJson(`/api/cld/${cld}/features`);
    for (const feature of data.features || []) {
      if (!isPolygon(feature)) continue;
      const geo = L.geoJSON(feature, { style: () => style(null, false) });
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
    setStatus(`Sending ${changed.length} boundary change${changed.length === 1 ? "" : "s"}…`, "pending");
    try {
      for (const layer of changed) {
        const id = Number(layer.feature?.id);
        if (!Number.isFinite(id)) throw new Error("A boundary is missing its feature id");
        const payload = { type: "Feature", id, properties: layer.feature.properties || {}, geometry: layer.toGeoJSON().geometry };
        await getJson(`/api/cld/${cld}/features/${id}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
        layer.feature.geometry = payload.geometry;
        dirty.delete(layer);
      }
      setStatus("Geometry saved");
    } catch (error) {
      setStatus(`Geometry save failed: ${error.message}`, "error");
    } finally {
      saveButton.disabled = dirty.size === 0;
    }
  });
})();
