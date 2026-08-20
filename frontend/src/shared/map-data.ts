export type FeatureProperties = Record<string, unknown>;
export type Geometry = { type?: string } | null | undefined;
export type RegionFeature = { properties?: FeatureProperties; geometry?: Geometry } | null | undefined;

export function isNonEmpty(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

export function escapeHtml(value: unknown): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function isPolygonGeometry(geometry: Geometry): boolean {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

export function isPointGeometry(geometry: Geometry): boolean {
  return geometry?.type === "Point";
}

export function hasDwellingIdentifier(props: FeatureProperties | null | undefined): boolean {
  return isNonEmpty(props?.dwellingNo) || isNonEmpty(props?.DWELLING_NO) || isNonEmpty(props?.vrNumber) || isNonEmpty(props?.VR_NUMBER);
}

export function getZoneKind(props: FeatureProperties | null | undefined): "cu" | "block" | "" {
  if (!props || typeof props !== "object") return "";
  const group = String(props._group || "").trim().toLowerCase();
  if (group === "cu" || group === "cus") return "cu";
  if (group === "blocks" || group === "block") return "block";
  if (isNonEmpty(props.COLB_UID) || isNonEmpty(props.CB_COLCODE)) return "block";
  if (isNonEmpty(props.CU_TYPE) || isNonEmpty(props.CUID) || isNonEmpty(props.cu)) return "cu";
  return "";
}

export function isZoneFeature(feature: RegionFeature): boolean {
  return isPolygonGeometry(feature?.geometry) && (getZoneKind(feature?.properties) === "cu" || getZoneKind(feature?.properties) === "block");
}

export function isHiddenBlock(props: FeatureProperties | null | undefined): boolean {
  if (getZoneKind(props) !== "block") return false;
  const value = props?.hidden;
  return value === true || value === 1 || String(value || "").trim().toLowerCase() === "true";
}

export function isDwellingFeature(props: FeatureProperties | null | undefined, geometry: Geometry): boolean {
  if (!props || typeof props !== "object" || !isPointGeometry(geometry)) return false;
  const group = String(props._group || "").trim().toLowerCase();
  if (group === "special_locations") return false;
  return group === "dwellings" || group === "dwelling" || hasDwellingIdentifier(props);
}

export function isSpecialLocationFeature(props: FeatureProperties | null | undefined, geometry: Geometry): boolean {
  return isPointGeometry(geometry) && String(props?._group || "").trim().toLowerCase() === "special_locations";
}

export function extractCuCode(props: FeatureProperties | null | undefined): string {
  const cuId = props?.CUID;
  const cu = props?.cu;
  const name = props?.name;
  const label = props?.label;
  if (isNonEmpty(cuId)) return String(cuId).trim();
  if (isNonEmpty(cu)) return String(cu).trim();
  if (isNonEmpty(name)) return String(name).split("/")[0].trim();
  if (isNonEmpty(label)) return String(label).split("/")[0].trim();
  return "UNKNOWN";
}

export function extractBlockCode(props: FeatureProperties | null | undefined, fallback = ""): string {
  if (isNonEmpty(props?.CB_COLCODE)) return String(props?.CB_COLCODE).trim().padStart(2, "0");
  if (isNonEmpty(props?.block)) return String(props?.block).trim().padStart(2, "0");
  if (isNonEmpty(props?.GEOCODE)) return String(props?.GEOCODE).trim().slice(-2);
  const fromName = isNonEmpty(props?.name) ? String(props?.name).split("/")[1] : "";
  return fromName && fromName.trim().length > 0 ? fromName.trim().padStart(2, "0") : fallback;
}

export function extractDwellingNo(props: FeatureProperties | null | undefined, fallback = "0000"): string {
  const raw = props?.dwellingNo ?? props?.DWELLING_NO ?? props?.vrNumber ?? props?.VR_NUMBER;
  const digits = String(raw ?? "").replace(/\D/g, "");
  return digits ? digits.padStart(4, "0").slice(-4) : fallback;
}

export function displayDwellingNo(props: FeatureProperties | null | undefined, fallback = "0000"): string {
  const normalized = extractDwellingNo(props, fallback);
  const numeric = Number(normalized);
  return Number.isFinite(numeric) ? String(numeric) : normalized;
}

const DWELLING_STATUSES = new Set(["429", "400", "402", "701", "500", "312", "324", "000", "001", "601"]);

export function normalizeDwellingStatus(value: unknown): string {
  const status = String(value ?? "").trim();
  return DWELLING_STATUSES.has(status) ? status : "429";
}

export function hashText(value: unknown): number {
  const text = String(value || "");
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) hash = (hash * 31 + text.charCodeAt(index)) >>> 0;
  return hash;
}

export function buildColorMap(cuCodes: Iterable<string>): Map<string, { stroke: string; fill: string }> {
  const unique = [...new Set(cuCodes)].sort();
  const colors = new Map<string, { stroke: string; fill: string }>();
  const variants = [
    { strokeS: 78, strokeL: 28, fillS: 82, fillL: 52 }, { strokeS: 72, strokeL: 34, fillS: 76, fillL: 60 },
    { strokeS: 86, strokeL: 24, fillS: 88, fillL: 48 }, { strokeS: 68, strokeL: 30, fillS: 72, fillL: 56 }
  ];
  for (let index = 0; index < unique.length; index += 1) {
    const code = unique[index];
    const seed = hashText(code);
    const hue = Math.round(((index * 137.508) + (seed % 31) - 15 + 360) % 360);
    const variant = variants[seed % variants.length];
    colors.set(code, { stroke: `hsl(${hue} ${variant.strokeS}% ${variant.strokeL}%)`, fill: `hsl(${hue} ${variant.fillS}% ${variant.fillL}%)` });
  }
  return colors;
}
