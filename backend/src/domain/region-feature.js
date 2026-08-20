export function hasText(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

export function normalizeClD(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || "";
}

export function normalizeSsid(value) {
  return String(value || "").trim().toUpperCase();
}

export function normalizeDwellingNo(value) {
  if (!hasText(value)) return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(4, "0").slice(-4);
}

export const DWELLING_STATUSES = new Set(["429", "400", "402", "701", "500", "312", "324", "000", "001", "601"]);

export function normalizeDwellingStatus(value) {
  const status = String(value ?? "").trim();
  return DWELLING_STATUSES.has(status) ? status : "429";
}

export function buildFeatureCollection(features) {
  return {
    type: "FeatureCollection",
    features: Array.isArray(features) ? features : []
  };
}

export function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

export function featureFileNames() {
  return {
    cu: "cu.geojson",
    blocks: "blocks.geojson",
    dwellings: "dwellings.geojson"
  };
}

export function extractClDFromProperties(properties) {
  if (!properties || typeof properties !== "object") return "";
  const direct = normalizeClD(properties.cld || properties.CLD || properties.CFOP_CLD_ID);
  if (direct) return direct;
  const zone = normalizeClD(properties.zone || properties.CFOP_ZONE_ID);
  return zone ? zone.slice(0, 4) : "";
}

export function extractCuCode(properties) {
  if (!properties || typeof properties !== "object") return "";
  const direct = String(properties.CUID || properties.cu || "").trim();
  if (direct) return direct;
  return String(properties.name || properties.label || "").split("/")[0].trim();
}

export function extractBlockCode(properties) {
  if (!properties || typeof properties !== "object") return "";
  const direct = properties.block ?? properties.CB_COLCODE;
  if (hasText(direct)) return String(direct).trim().padStart(2, "0");
  if (hasText(properties.GEOCODE)) return String(properties.GEOCODE).trim().slice(-2);
  const fromName = String(properties.name || "").split("/")[1]?.trim();
  return fromName ? fromName.padStart(2, "0") : "";
}

export function isPointGeometry(geometry) {
  return geometry?.type === "Point";
}

export function isPolygonGeometry(geometry) {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

export function hasDwellingIdentifier(properties) {
  return Boolean(
    normalizeDwellingNo(properties?.dwellingNo ?? properties?.DWELLING_NO ?? properties?.vrNumber ?? properties?.VR_NUMBER)
  );
}

export function isSpecialLocationFeature(feature) {
  return String(feature?.properties?._group || "").trim().toLowerCase() === "special_locations";
}

export function normalizeDwellingProperties(properties) {
  const normalized = properties && typeof properties === "object" ? { ...properties } : {};
  const cu = extractCuCode(normalized);
  const block = extractBlockCode(normalized);
  const dwellingNo = normalizeDwellingNo(
    normalized.dwellingNo ?? normalized.DWELLING_NO ?? normalized.vrNumber ?? normalized.VR_NUMBER
  );
  const group = String(normalized._group || "").trim().toLowerCase();

  if (cu) normalized.cu = cu;
  if (block) normalized.block = block;
  if (dwellingNo) normalized.dwellingNo = dwellingNo;
  if (hasText(normalized.status)) normalized.status = normalizeDwellingStatus(normalized.status);
  if (group === "dwelling") normalized._group = "dwellings";
  if (group === "block") normalized._group = "blocks";
  if (group === "cus") normalized._group = "cu";
  return normalized;
}

export function getDwellingIdentity(properties) {
  const normalized = normalizeDwellingProperties(properties);
  const group = String(normalized._group || "").trim().toLowerCase();
  const looksLikeDwelling = group === "dwellings" || hasText(normalized.dwellingNo);
  if (!looksLikeDwelling || !normalized.cu || !normalized.dwellingNo) return null;
  return { cuCode: normalized.cu, dwellingNo: normalized.dwellingNo };
}

export function normalizeRegionFeature(feature) {
  const normalized = feature && typeof feature === "object" ? { ...feature } : {};
  normalized.type = "Feature";
  normalized.properties = normalizeDwellingProperties(normalized.properties);
  normalized.geometry = normalized.geometry && typeof normalized.geometry === "object" ? { ...normalized.geometry } : null;
  if (normalized.id !== undefined && normalized.id !== null && normalized.id !== "") {
    const numericId = Number(normalized.id);
    normalized.id = Number.isFinite(numericId) ? numericId : normalized.id;
  }
  return normalized;
}

export function classifyFeature(feature) {
  const normalized = normalizeRegionFeature(feature);
  const properties = normalized.properties || {};
  const geometry = normalized.geometry || {};
  const group = String(properties._group || "").trim().toLowerCase();
  if (isPointGeometry(geometry)) return "dwellings";
  if (!isPolygonGeometry(geometry)) return "";
  if (group === "cu" || group === "cus") return "cu";
  if (group === "blocks" || group === "block") return "blocks";
  if (hasText(properties.COLB_UID) || hasText(properties.CB_COLCODE) || hasText(properties.block) || hasText(properties.GEOCODE)) {
    return "blocks";
  }
  if (hasText(properties.CUID) || hasText(properties.cu) || hasText(properties.CU_TYPE)) return "cu";
  return "";
}

export function normalizeFeatures(payload) {
  if (Array.isArray(payload)) return payload.map(normalizeRegionFeature);
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.features)) return payload.features.map(normalizeRegionFeature);
    if (payload.type === "Feature") return [normalizeRegionFeature(payload)];
  }
  return [];
}
