#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SERVICE_URL =
  "https://geoprod.statcan.gc.ca/geo_wa/rest/services/2026_GM_CAM_CFOP_EN_202506/MapServer";
const DEFAULT_CLD_ROOT = path.join(process.cwd(), "data", "cld");
const DEFAULT_ARCHIVE_ROOT = path.join(process.cwd(), "data", "statcan", "2026_GM_CAM_CFOP_EN_202506");
const PAGE_SIZE = 2000;
const MIN_PAGE_SIZE = 25;

function usage() {
  console.error(
    "Usage: node scripts/import-statcan-all.mjs [--service-url <MapServer URL>] [--cld-root data/cld] [--archive-root data/statcan/<service>]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    serviceUrl: DEFAULT_SERVICE_URL,
    cldRoot: DEFAULT_CLD_ROOT,
    archiveRoot: DEFAULT_ARCHIVE_ROOT
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--service-url") {
      args.serviceUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--cld-root") {
      args.cldRoot = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--archive-root") {
      args.archiveRoot = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") usage();
    throw new Error(`Unknown argument: ${token}`);
  }

  if (!args.serviceUrl) usage();
  return args;
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBlockCode(value) {
  const raw = String(value || "").trim();
  return raw ? raw.padStart(2, "0") : "";
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function getJson(url, params = {}) {
  const response = await fetch(buildUrl(url, params));
  if (!response.ok) {
    throw new Error(`Request failed (${response.status}) ${response.statusText}: ${response.url}`);
  }
  const payload = await response.json();
  if (payload?.error) {
    throw new Error(`ArcGIS error on ${response.url}: ${payload.error.message || "Unknown error"}`);
  }
  return payload;
}

function closeRing(ring) {
  if (!Array.isArray(ring) || ring.length === 0) return [];
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function signedArea(ring) {
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    sum += (x1 * y2) - (x2 * y1);
  }
  return sum / 2;
}

function isClockwise(ring) {
  return signedArea(ring) < 0;
}

function pointInRing(point, ring) {
  const [x, y] = point;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i, i += 1) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    const intersects =
      (yi > y) !== (yj > y) &&
      x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function convertPolygonRings(rings) {
  const prepared = (rings || [])
    .filter((ring) => Array.isArray(ring) && ring.length >= 4)
    .map(closeRing);

  const outers = [];
  const holes = [];

  for (const ring of prepared) {
    if (isClockwise(ring)) outers.push([ring]);
    else holes.push(ring);
  }

  if (outers.length === 0 && prepared.length > 0) {
    return { type: "Polygon", coordinates: [prepared[0]] };
  }

  for (const hole of holes) {
    const sample = hole[0];
    let placed = false;
    for (const poly of outers) {
      if (pointInRing(sample, poly[0])) {
        poly.push(hole);
        placed = true;
        break;
      }
    }
    if (!placed) outers.push([hole]);
  }

  if (outers.length === 1) {
    return { type: "Polygon", coordinates: outers[0] };
  }

  return {
    type: "MultiPolygon",
    coordinates: outers.map((poly) => [poly[0], ...poly.slice(1)])
  };
}

function convertGeometry(geometry, geometryType) {
  if (!geometry) return null;
  if (geometryType === "esriGeometryPoint") {
    return { type: "Point", coordinates: [geometry.x, geometry.y] };
  }
  if (geometryType === "esriGeometryPolyline") {
    if (!Array.isArray(geometry.paths)) return null;
    return geometry.paths.length === 1
      ? { type: "LineString", coordinates: geometry.paths[0] }
      : { type: "MultiLineString", coordinates: geometry.paths };
  }
  if (geometryType === "esriGeometryPolygon") {
    if (!Array.isArray(geometry.rings)) return null;
    return convertPolygonRings(geometry.rings);
  }
  return null;
}

function geometryBboxCenter(geometry) {
  const coords = [];

  function collect(value) {
    if (!Array.isArray(value)) return;
    if (value.length >= 2 && value.every((item) => typeof item === "number")) {
      coords.push(value);
      return;
    }
    for (const item of value) collect(item);
  }

  if (!geometry) return null;
  if (geometry.type === "Point") {
    return { lon: geometry.coordinates[0], lat: geometry.coordinates[1] };
  }

  collect(geometry.coordinates);
  if (coords.length === 0) return null;

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  for (const [lon, lat] of coords) {
    minLon = Math.min(minLon, lon);
    minLat = Math.min(minLat, lat);
    maxLon = Math.max(maxLon, lon);
    maxLat = Math.max(maxLat, lat);
  }

  return {
    lon: (minLon + maxLon) / 2,
    lat: (minLat + maxLat) / 2
  };
}

async function getLayerInfo(serviceUrl, layerId) {
  return getJson(`${serviceUrl}/${layerId}`, { f: "pjson" });
}

async function queryCount(serviceUrl, layerId) {
  const payload = await getJson(`${serviceUrl}/${layerId}/query`, {
    where: "1=1",
    returnCountOnly: true,
    f: "pjson"
  });
  return Number(payload.count || 0);
}

async function fetchPage(serviceUrl, layerId, offset, pageSize) {
  return getJson(`${serviceUrl}/${layerId}/query`, {
    where: "1=1",
    outFields: "*",
    returnGeometry: true,
    outSR: 4326,
    f: "pjson",
    resultOffset: offset,
    resultRecordCount: pageSize,
    orderByFields: "OBJECTID ASC"
  });
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function enrichFeature(feature, kind, cuToClD = new Map()) {
  const properties = { ...(feature.properties || {}) };
  const center = geometryBboxCenter(feature.geometry);

  if (kind === "cld") {
    properties.cld = normalizeDigits(properties.CFOP_CLD_ID);
    properties.name = properties.cld;
    properties.label = properties.cld;
  } else if (kind === "cu") {
    properties.cld = normalizeDigits(properties.CFOP_CLD_ID);
    properties.cu = String(properties.CUID || "").trim();
    properties.zone = String(properties.CFOP_ZONE_ID || "").trim();
    properties.name = properties.cu;
    properties.label = properties.cu;
  } else if (kind === "block") {
    const cu = String(properties.CUID || "").trim();
    const block = normalizeBlockCode(properties.CB_COLCODE);
    properties.cu = cu;
    properties.block = block;
    properties.cld = normalizeDigits(cuToClD.get(cu));
    properties.name = [cu, block].filter(Boolean).join("/");
    properties.label = block || String(properties.GEOCODE || "").trim();
  }

  if (center) {
    properties.center_lon = Number(center.lon.toFixed(6));
    properties.center_lat = Number(center.lat.toFixed(6));
  }

  return {
    ...feature,
    properties
  };
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function appendGroupedNdjson(rootDir, fileName, grouped) {
  const writes = [];
  for (const [cld, features] of grouped.entries()) {
    if (!features.length) continue;
    const filePath = path.join(rootDir, cld, fileName);
    const payload = `${features.map((feature) => JSON.stringify(feature)).join("\n")}\n`;
    writes.push(
      fs.mkdir(path.dirname(filePath), { recursive: true }).then(() => fs.appendFile(filePath, payload))
    );
  }
  await Promise.all(writes);
}

async function readNdjsonFeatures(filePath) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

async function writeFeatureCollectionFromNdjson(inputPath, outputPath) {
  const features = await readNdjsonFeatures(inputPath);
  await writeJson(outputPath, { type: "FeatureCollection", features });
}

function ensureState(states, cld) {
  if (!states.has(cld)) {
    states.set(cld, {
      cld,
      zones: new Set(),
      cuCodes: new Set(),
      blocksByCu: new Map(),
      cldFeature: null,
      cuCount: 0,
      blockCount: 0
    });
  }
  return states.get(cld);
}

async function forEachPage(serviceUrl, layerId, geometryType, label, onPage) {
  const count = await queryCount(serviceUrl, layerId);
  let offset = 0;
  let pageSize = PAGE_SIZE;
  let page = 0;

  while (offset < count) {
    let payload;
    try {
      payload = await fetchPage(serviceUrl, layerId, offset, pageSize);
    } catch (error) {
      if (pageSize <= MIN_PAGE_SIZE) throw error;
      pageSize = Math.max(MIN_PAGE_SIZE, Math.floor(pageSize / 2));
      console.log(`${label}: reducing page size to ${pageSize} at offset ${offset}`);
      continue;
    }

    const features = [];
    for (const feature of payload.features || []) {
      const geometry = convertGeometry(feature.geometry, geometryType);
      if (!geometry) continue;
      features.push({
        type: "Feature",
        ...(feature.attributes?.OBJECTID !== undefined ? { id: feature.attributes.OBJECTID } : {}),
        properties: { ...(feature.attributes || {}) },
        geometry
      });
    }

    await onPage(features, { count, page: page + 1, pageSize, offset });
    page += 1;
    offset += pageSize;
    console.log(`${label}: page ${page}, fetched ${Math.min(offset, count)}/${count}, pageSize ${pageSize}`);
  }
}

async function main() {
  const args = parseArgs(process.argv);
  const serviceUrl = args.serviceUrl.replace(/\/+$/, "");
  const tempRoot = path.join(args.archiveRoot, "tmp");

  await fs.mkdir(args.archiveRoot, { recursive: true });
  await fs.mkdir(args.cldRoot, { recursive: true });
  await fs.rm(tempRoot, { recursive: true, force: true });
  await fs.mkdir(tempRoot, { recursive: true });

  const [cldLayer, cuLayer, blockLayer] = await Promise.all([
    getLayerInfo(serviceUrl, 3),
    getLayerInfo(serviceUrl, 5),
    getLayerInfo(serviceUrl, 6)
  ]);

  const states = new Map();
  const cuToClD = new Map();
  let cldCount = 0;
  let cuCount = 0;
  let blockCount = 0;

  await forEachPage(serviceUrl, 3, cldLayer.geometryType, "CLD", async (pageFeatures) => {
    const grouped = new Map();
    for (const rawFeature of pageFeatures) {
      const feature = enrichFeature(rawFeature, "cld");
      const cld = String(feature.properties?.cld || "").trim();
      if (!cld) continue;
      ensureState(states, cld).cldFeature = feature;
      grouped.set(cld, [feature]);
      cldCount += 1;
    }
    await appendGroupedNdjson(tempRoot, "cld.ndjson", grouped);
  });

  await forEachPage(serviceUrl, 5, cuLayer.geometryType, "CU", async (pageFeatures) => {
    const grouped = new Map();
    for (const rawFeature of pageFeatures) {
      const feature = enrichFeature(rawFeature, "cu");
      const cld = String(feature.properties?.cld || "").trim();
      const cu = String(feature.properties?.cu || "").trim();
      if (!cld) continue;
      const state = ensureState(states, cld);
      state.cuCount += 1;
      state.zones.add(String(feature.properties?.zone || "").trim());
      state.cuCodes.add(cu);
      cuToClD.set(cu, cld);
      if (!grouped.has(cld)) grouped.set(cld, []);
      grouped.get(cld).push(feature);
      cuCount += 1;
    }
    await appendGroupedNdjson(tempRoot, "cu.ndjson", grouped);
  });

  await forEachPage(serviceUrl, 6, blockLayer.geometryType, "COLB", async (pageFeatures) => {
    const grouped = new Map();
    for (const rawFeature of pageFeatures) {
      const feature = enrichFeature(rawFeature, "block", cuToClD);
      const cld = String(feature.properties?.cld || "").trim();
      const cu = String(feature.properties?.cu || "").trim();
      if (!cld) continue;
      const state = ensureState(states, cld);
      state.blockCount += 1;
      state.blocksByCu.set(cu, (state.blocksByCu.get(cu) || 0) + 1);
      if (!grouped.has(cld)) grouped.set(cld, []);
      grouped.get(cld).push(feature);
      blockCount += 1;
    }
    await appendGroupedNdjson(tempRoot, "blocks.ndjson", grouped);
  });

  const cldCodes = uniqueSorted([...states.keys()]);
  const manifest = {
    serviceUrl,
    exportedAt: new Date().toISOString(),
    counts: {
      cld: cldCount,
      cu: cuCount,
      blocks: blockCount,
      cldFolders: cldCodes.length
    },
    files: {
      perClD: "data/cld/<CLD>/{cld,cu,blocks,index}.geojson/json"
    }
  };
  await writeJson(path.join(args.archiveRoot, "manifest.json"), manifest);

  for (let index = 0; index < cldCodes.length; index += 1) {
    const cld = cldCodes[index];
    const state = states.get(cld);
    const outDir = path.join(args.cldRoot, cld);
    const cldFeature = state?.cldFeature || null;
    const cldProps = cldFeature?.properties || {};
    const cuCodes = uniqueSorted([...(state?.cuCodes || [])]);
    const zones = uniqueSorted([...(state?.zones || [])]);
    const blocksByCu = Object.fromEntries(
      [...(state?.blocksByCu || new Map()).entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    const indexJson = {
      cld,
      name: cld,
      serviceUrl,
      exportedAt: manifest.exportedAt,
      counts: {
        cld: cldFeature ? 1 : 0,
        cu: state?.cuCount || 0,
        blocks: state?.blockCount || 0
      },
      zones,
      cuCodes,
      blocksByCu,
      cldProperties: {
        CFOP_CLD_ID: cldProps.CFOP_CLD_ID || "",
        CFOP_CLD_TYPE: cldProps.CFOP_CLD_TYPE || "",
        ENG_CFOP_CLD_TYPE: cldProps.ENG_CFOP_CLD_TYPE || "",
        FRE_CFOP_CLD_TYPE: cldProps.FRE_CFOP_CLD_TYPE || "",
        RCC_ID: cldProps.RCC_ID || "",
        FOM_ID: cldProps.FOM_ID || "",
        CFOP_FOS_ID: cldProps.CFOP_FOS_ID || ""
      },
      files: {
        cld: "cld.geojson",
        cu: "cu.geojson",
        blocks: "blocks.geojson"
      }
    };

    await Promise.all([
      writeFeatureCollectionFromNdjson(path.join(tempRoot, cld, "cld.ndjson"), path.join(outDir, "cld.geojson")),
      writeFeatureCollectionFromNdjson(path.join(tempRoot, cld, "cu.ndjson"), path.join(outDir, "cu.geojson")),
      writeFeatureCollectionFromNdjson(path.join(tempRoot, cld, "blocks.ndjson"), path.join(outDir, "blocks.geojson")),
      writeJson(path.join(outDir, "index.json"), indexJson)
    ]);

    if ((index + 1) % 100 === 0 || index + 1 === cldCodes.length) {
      console.log(`Split CLD folders: ${index + 1}/${cldCodes.length}`);
    }
  }

  await fs.rm(tempRoot, { recursive: true, force: true });

  console.log(
    JSON.stringify(
      {
        archiveRoot: args.archiveRoot,
        cldRoot: args.cldRoot,
        counts: manifest.counts
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
