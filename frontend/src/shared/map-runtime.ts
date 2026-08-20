type Coordinates = { lat: number; lng: number };
type PositionLike = { coords: { latitude: number; longitude: number; accuracy: number } };
type TileLayer = { addTo(map: MapLike): TileLayer; on(event: string, listener: () => void): void };
type Marker = { setLatLng(latlng: Coordinates): void; addTo(map: MapLike): Marker };
type Circle = { setLatLng(latlng: Coordinates): void; setRadius(radius: number): void; addTo(map: MapLike): Circle };
type MapLike = {
  getCenter(): Coordinates; getZoom(): number; setView(latlng: [number, number], zoom: number): MapLike; setZoom(zoom: number): void;
  on(events: string, listener: () => void): void; removeLayer(layer: TileLayer): void; addLayer(layer: TileLayer): void;
  flyTo(latlng: Coordinates, zoom: number, options: { duration: number }): void;
};
type LeafletApi = {
  map(container: string, options: Record<string, unknown>): MapLike;
  control: { zoom(options: Record<string, unknown>): { addTo(map: MapLike): unknown } };
  tileLayer(url: string, options: Record<string, unknown>): TileLayer;
  marker(latlng: Coordinates, options: Record<string, unknown>): Marker;
  circle(latlng: Coordinates, options: Record<string, unknown>): Circle;
  icon(options: Record<string, unknown>): unknown;
  latLng(lat: number, lng: number): Coordinates;
};
type NativeGeolocation = {
  requestPermissions(): Promise<unknown>;
  getCurrentPosition(options: Record<string, unknown>): Promise<PositionLike>;
  watchPosition(options: Record<string, unknown>, callback: (position: PositionLike | null, error?: unknown) => void): Promise<string>;
};
type Capacitor = { isNativePlatform?: () => boolean; Plugins?: { Geolocation?: NativeGeolocation } };
const leaflet = (window as unknown as { L: LeafletApi }).L;

export type MapUrlState = { zoom: number | null; lat: number | null; lng: number | null; hasCenter: boolean };
export type CommonMapShellOptions = {
  mapOptions?: Record<string, unknown>;
  baseMapButton?: HTMLElement | null;
  tileCacheStatus?: HTMLElement | null;
  locateButton?: HTMLElement | null;
  userLocationMarkerOptions?: Record<string, unknown>;
  onQueryChange?: (query: string) => void;
};

export function readMapUrlState(): MapUrlState {
  const params = new URLSearchParams(window.location.search);
  const zoomValue = params.get("zoom");
  const latValue = params.get("lat");
  const lngValue = params.get("lng");
  const zoom = zoomValue === null ? null : Number(zoomValue);
  const lat = latValue === null ? null : Number(latValue);
  const lng = lngValue === null ? null : Number(lngValue);
  const hasCenter = lat !== null && lng !== null && Number.isFinite(lat) && Number.isFinite(lng) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  return { zoom, lat, lng, hasCenter };
}

export function bindMapUrlState(map: MapLike, requested: MapUrlState, onQueryChange?: (query: string) => void) {
  function sync(): void {
    const center = map.getCenter();
    const params = new URLSearchParams(window.location.search);
    params.set("zoom", String(Math.round(map.getZoom())));
    params.set("lat", center.lat.toFixed(6));
    params.set("lng", center.lng.toFixed(6));
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}?${query}${window.location.hash}`);
    onQueryChange?.(query);
  }
  function applyRequestedMapView(): void {
    if (requested.hasCenter && requested.lat !== null && requested.lng !== null) {
      const zoom = Number.isFinite(requested.zoom) ? Math.max(0, Math.min(22, requested.zoom as number)) : map.getZoom();
      map.setView([requested.lat, requested.lng], zoom);
    } else if (Number.isFinite(requested.zoom)) map.setZoom(Math.max(0, Math.min(22, requested.zoom as number)));
    sync();
  }
  map.on("zoomend moveend", sync);
  return { sync, applyRequestedMapView };
}

export function setupBaseMap(map: MapLike, button?: HTMLElement | null) {
  const satelliteLayer = leaflet.tileLayer("/tiles/satellite/{z}/{y}/{x}", { maxZoom: 22, maxNativeZoom: 17, attribution: "Tiles &copy; Esri" });
  const schematicLayer = leaflet.tileLayer("/tiles/schematic/{z}/{y}/{x}", { maxZoom: 19, attribution: "&copy; OpenStreetMap contributors" });
  let currentMode: "satellite" | "schematic" = "satellite";
  satelliteLayer.addTo(map);
  function updateButton(): void {
    const modeLabel = currentMode === "satellite" ? "Satellite" : "Schematic";
    button?.setAttribute("title", `Switch base map (current: ${modeLabel})`);
    button?.setAttribute("aria-label", `Switch base map (current: ${modeLabel})`);
  }
  function setMode(mode: "satellite" | "schematic"): void {
    if (mode === currentMode) return;
    if (mode === "satellite") { map.removeLayer(schematicLayer); map.addLayer(satelliteLayer); }
    else { map.removeLayer(satelliteLayer); map.addLayer(schematicLayer); }
    currentMode = mode;
    updateButton();
  }
  if (button) {
    button.textContent = "🗺️";
    button.addEventListener("click", (event) => { event.preventDefault(); event.stopPropagation(); setMode(currentMode === "satellite" ? "schematic" : "satellite"); });
  }
  updateButton();
  return { satelliteLayer, schematicLayer, setMode };
}

export function setupTileCacheStatus(statusElement: HTMLElement | null | undefined, layers: TileLayer[]): void {
  if (!statusElement) return;
  const element = statusElement;
  let refreshTimer: number | undefined;
  async function refresh(): Promise<void> {
    if (!("caches" in window)) { element.textContent = "Tiles: cache unavailable"; return; }
    try {
      const cache = await caches.open("cmp-map-tiles-v1");
      const requests = await cache.keys();
      let bytes = 0;
      for (const request of requests) {
        const response = await cache.match(request);
        if (!response) continue;
        const length = Number(response.headers.get("x-censusmap-size") || response.headers.get("content-length"));
        bytes += Number.isFinite(length) && length >= 0 ? length : (await response.blob()).size;
      }
      const megabytes = bytes / (1024 * 1024);
      element.textContent = `Tiles: ${megabytes < 10 ? megabytes.toFixed(1) : Math.round(megabytes)} MB · ${requests.length}`;
    } catch { element.textContent = "Tiles: cache unavailable"; }
  }
  function scheduleRefresh(): void { window.clearTimeout(refreshTimer); refreshTimer = window.setTimeout(() => void refresh(), 1200); }
  layers.forEach((layer) => layer.on("load", scheduleRefresh));
  void refresh();
  window.setInterval(() => void refresh(), 120000);
}

export function createCommonMapShell(options: CommonMapShellOptions = {}) {
  const map = leaflet.map("map", {
    preferCanvas: false,
    zoomControl: false,
    tap: true,
    markerZoomAnimation: true,
    zoomAnimation: true,
    fadeAnimation: true,
    ...options.mapOptions
  }).setView([56, -96], 4);
  const mapUrlState = bindMapUrlState(map, readMapUrlState(), options.onQueryChange);
  leaflet.control.zoom({ position: "bottomright" }).addTo(map);
  const baseMap = setupBaseMap(map, options.baseMapButton);
  setupTileCacheStatus(options.tileCacheStatus, [baseMap.satelliteLayer, baseMap.schematicLayer]);
  const userLocationTracker = createUserLocationTracker(map, options.userLocationMarkerOptions);
  if (options.locateButton) {
    options.locateButton.textContent = "🧍";
    options.locateButton.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await userLocationTracker.focus();
    });
  }
  return { map, mapUrlState, baseMap, userLocationTracker };
}

export function createUserLocationTracker(map: MapLike, markerOptions: Record<string, unknown> = {}) {
  let marker: Marker | null = null;
  let accuracyCircle: Circle | null = null;
  let watchId: number | string | null = null;
  let lastKnownLatLng: Coordinates | null = null;
  const capacitor = (): Capacitor | undefined => (window as unknown as { Capacitor?: Capacitor }).Capacitor;
  function upsert(latlng: Coordinates, accuracyMeters: number): void {
    lastKnownLatLng = latlng;
    if (!marker) marker = leaflet.marker(latlng, { icon: leaflet.icon({ iconUrl: "/person-marker.svg?v=20260721e", iconSize: [36, 36], iconAnchor: [18, 30] }), interactive: false, ...markerOptions }).addTo(map);
    else marker.setLatLng(latlng);
    if (!accuracyCircle) accuracyCircle = leaflet.circle(latlng, { radius: accuracyMeters, color: "#2563eb", fillColor: "#60a5fa", fillOpacity: 0.14, weight: 1 }).addTo(map);
    else { accuracyCircle.setLatLng(latlng); accuracyCircle.setRadius(accuracyMeters); }
  }
  async function requestCurrentLocation(): Promise<PositionLike | GeolocationPosition | null> {
    const geoPlugin = capacitor()?.Plugins?.Geolocation;
    if (capacitor()?.isNativePlatform?.() && geoPlugin) {
      try { await geoPlugin.requestPermissions(); return await geoPlugin.getCurrentPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }); } catch { /* browser fallback */ }
    }
    if (!navigator.geolocation) return null;
    return new Promise((resolve) => navigator.geolocation.getCurrentPosition(resolve, () => resolve(null), { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }));
  }
  async function start(): Promise<void> {
    const firstPosition = await requestCurrentLocation();
    if (firstPosition?.coords) upsert(leaflet.latLng(firstPosition.coords.latitude, firstPosition.coords.longitude), firstPosition.coords.accuracy || 0);
    const geoPlugin = capacitor()?.Plugins?.Geolocation;
    if (capacitor()?.isNativePlatform?.() && geoPlugin) {
      try { await geoPlugin.requestPermissions(); watchId = await geoPlugin.watchPosition({ enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 }, (position, error) => { if (!error && position?.coords) upsert(leaflet.latLng(position.coords.latitude, position.coords.longitude), position.coords.accuracy || 0); }); return; } catch { /* browser fallback */ }
    }
    if (navigator.geolocation) watchId = navigator.geolocation.watchPosition((position) => upsert(leaflet.latLng(position.coords.latitude, position.coords.longitude), position.coords.accuracy || 0), () => {}, { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000 });
  }
  async function focus(): Promise<void> {
    if (lastKnownLatLng) { map.flyTo(lastKnownLatLng, Math.max(map.getZoom(), 15), { duration: 0.6 }); return; }
    const position = await requestCurrentLocation();
    if (position?.coords) { const latlng = leaflet.latLng(position.coords.latitude, position.coords.longitude); upsert(latlng, position.coords.accuracy || 0); map.flyTo(latlng, Math.max(map.getZoom(), 15), { duration: 0.6 }); }
  }
  function stop(): void { if (typeof watchId === "number") navigator.geolocation?.clearWatch?.(watchId); watchId = null; }
  return { start, focus, stop };
}
