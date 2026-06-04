import fs from "node:fs";
import path from "node:path";

const SERVICE_URL = "https://geoprod.statcan.gc.ca/geo_wa/rest/services/2026_GM_CAM_CFOP_EN_202506/MapServer";
const DEFAULT_BBOX = "5813525.98973438,1994482.7669431788,5821123.857188448,1999516.8548696882";
const DEFAULT_SIZE = "1138,754";
const DEFAULT_LAYERS = "0,1,8,9,4,3,6,5";

function parseNumberList(value, expectedLength) {
  const parts = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()));
  if (parts.length !== expectedLength || parts.some((item) => !Number.isFinite(item))) {
    throw new Error(`Expected ${expectedLength} numeric values, got: ${value}`);
  }
  return parts;
}

function buildScale(bbox, size, dpi = 96) {
  const [xmin, ymin, xmax, ymax] = bbox;
  const [widthPx, heightPx] = size;
  const widthMeters = xmax - xmin;
  const heightMeters = ymax - ymin;
  const metersPerPixel = Math.max(widthMeters / widthPx, heightMeters / heightPx);
  const inchesPerMeter = 39.37007874015748;
  return metersPerPixel * dpi * inchesPerMeter;
}

function parseRequestedLayers(value) {
  return String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function expectedLabelLayerIds(requestedLayerIds) {
  const labels = [];
  for (const layerId of requestedLayerIds) {
    if (layerId >= 0 && layerId <= 7) {
      labels.push(layerId + 8);
    }
  }
  return [...new Set(labels)];
}

function visibleAtScale(layer, scale) {
  const minScale = Number(layer.minScale || 0);
  const maxScale = Number(layer.maxScale || 0);
  const passesMin = minScale === 0 || scale <= minScale;
  const passesMax = maxScale === 0 || scale >= maxScale;
  return passesMin && passesMax;
}

async function getJson(url) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}): ${url}`);
  }
  return response.json();
}

async function main() {
  const bbox = parseNumberList(process.env.BBOX || DEFAULT_BBOX, 4);
  const size = parseNumberList(process.env.SIZE || DEFAULT_SIZE, 2);
  const requestedLayerIds = parseRequestedLayers(process.env.LAYERS || DEFAULT_LAYERS);
  const scale = buildScale(bbox, size);
  const metadata = await getJson(`${SERVICE_URL}?f=pjson`);
  const layers = Array.isArray(metadata.layers) ? metadata.layers : [];
  const byId = new Map(layers.map((layer) => [Number(layer.id), layer]));
  const expectedLabels = expectedLabelLayerIds(requestedLayerIds);

  const requested = requestedLayerIds.map((id) => {
    const layer = byId.get(id);
    return {
      id,
      name: layer?.name || "UNKNOWN",
      minScale: layer?.minScale ?? null,
      maxScale: layer?.maxScale ?? null,
      visibleAtScale: layer ? visibleAtScale(layer, scale) : false
    };
  });

  const missingExpectedLabels = expectedLabels.filter((id) => !requestedLayerIds.includes(id));

  const report = {
    serviceUrl: SERVICE_URL,
    bbox,
    size,
    scale,
    requestedLayers: requested,
    expectedLabelLayerIds: expectedLabels,
    missingExpectedLabelLayerIds: missingExpectedLabels,
    recommendation:
      missingExpectedLabels.length > 0
        ? `Use layers=show:${[...new Set([...requestedLayerIds, ...missingExpectedLabels])].join(",")}`
        : "Requested layer set already includes matching label layers."
  };

  const reportPath = path.join(process.cwd(), "docs", "STATCAN_EXPORT_CHECK.json");
  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
