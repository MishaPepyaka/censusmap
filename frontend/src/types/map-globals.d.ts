declare namespace CensusMap {
  type JsonObject = Record<string, unknown>;
  type GeoJsonGeometry = { type: string; coordinates: unknown };
  type GeoJsonFeature = { type: "Feature"; id?: number | string; properties: JsonObject; geometry: GeoJsonGeometry | null };
  type RegionMutation = {
    id: string;
    method: "POST" | "PUT" | "DELETE";
    url: string;
    payload?: GeoJsonFeature;
    dedupeKey?: string;
    baseRevision?: number;
    queuedAt?: number;
    revision?: number;
  };
}

declare const L: {
  map: (...args: any[]) => any;
  control: { zoom: (...args: any[]) => { addTo: (map: any) => unknown } };
  tileLayer: (...args: any[]) => { addTo: (map: any) => unknown };
  featureGroup: () => any;
  layerGroup: () => any;
  geoJSON: (...args: any[]) => any;
  circleMarker: (...args: any[]) => any;
  marker: (...args: any[]) => any;
  divIcon: (...args: any[]) => any;
  LatLng: new (...args: any[]) => any;
};
