#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";

const DEFAULT_SERVICE_URL =
  "https://geoprod.statcan.gc.ca/geo_wa/rest/services/2026_GM_CAM_CFOP_EN_202506/MapServer";
const DEFAULT_ROOT = path.join(process.cwd(), "data", "cld");
const PAGE_SIZE = 2000;

function usage() {
  console.error(
    "Usage: node scripts/import-statcan-cld.mjs --cld <CLD> [--out-root data/cld] [--service-url <MapServer URL>]"
  );
  process.exit(1);
}

function parseArgs(argv) {
  const args = {
    cld: "",
    outRoot: DEFAULT_ROOT,
    serviceUrl: DEFAULT_SERVICE_URL
  };

  for (let i = 2; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === "--cld") {
      args.cld = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--out-root") {
      args.outRoot = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--service-url") {
      args.serviceUrl = argv[i + 1] || "";
      i += 1;
      continue;
    }
    if (token === "--help" || token === "-h") {
      usage();
    }
    throw new Error(`Unknown argument: ${token}`);
  }

  args.cld = normalizeDigits(args.cld);
  if (!args.cld) usage();
  return args;
}

function normalizeDigits(value) {
  return String(value || "").replace(/\D/g, "");
}

function normalizeBlockCode(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw.padStart(2, "0");
}

function buildUrl(baseUrl, params) {
  const url = new URL(baseUrl);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

async function getJson(url, params = {}) {
  if (typeof fetch !== "function") {
    throw new Error("This script requires Node.js with global fetch support.");
  }
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
    if (isClockwise(ring)) {
      outers.push([ring]);
    } else {
      holes.push(ring);
    }
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
    if (!placed) {
      outers.push([hole]);
    }
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

async function queryCount(serviceUrl, layerId, where) {
  const payload = await getJson(`${serviceUrl}/${layerId}/query`, {
    where,
    returnCountOnly: true,
    f: "pjson"
  });
  return Number(payload.count || 0);
}

async function queryAllFeatures(serviceUrl, layerId, where, geometryType) {
  const count = await queryCount(serviceUrl, layerId, where);
  const features = [];

  for (let offset = 0; offset < count; offset += PAGE_SIZE) {
    const payload = await getJson(`${serviceUrl}/${layerId}/query`, {
      where,
      outFields: "*",
      returnGeometry: true,
      outSR: 4326,
      f: "pjson",
      resultOffset: offset,
      resultRecordCount: PAGE_SIZE,
      orderByFields: "OBJECTID ASC"
    });

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
  }

  return { type: "FeatureCollection", features };
}

function enrichFeatureCollection(collection, kind, cldCode, cuToClD = new Map()) {
  return {
    type: "FeatureCollection",
    features: (collection.features || []).map((feature) => {
      const properties = { ...(feature.properties || {}) };
      const center = geometryBboxCenter(feature.geometry);

      if (kind === "cld") {
        properties.cld = normalizeDigits(properties.CFOP_CLD_ID || cldCode);
        properties.name = properties.cld;
        properties.label = properties.cld;
      }

      if (kind === "cu") {
        properties.cld = normalizeDigits(properties.CFOP_CLD_ID || cldCode);
        properties.cu = String(properties.CUID || "").trim();
        properties.zone = String(properties.CFOP_ZONE_ID || "").trim();
        properties.name = properties.cu;
        properties.label = properties.cu;
      }

      if (kind === "block") {
        const cu = String(properties.CUID || "").trim();
        const block = normalizeBlockCode(properties.CB_COLCODE);
        properties.cu = cu;
        properties.block = block;
        properties.cld = normalizeDigits(cuToClD.get(cu) || cldCode);
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
    })
  };
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => String(a).localeCompare(String(b)));
}

function chunk(values, size) {
  const groups = [];
  for (let i = 0; i < values.length; i += size) {
    groups.push(values.slice(i, i + size));
  }
  return groups;
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function main() {
  const args = parseArgs(process.argv);
  const serviceUrl = args.serviceUrl.replace(/\/+$/, "");
  const outDir = path.join(args.outRoot, args.cld);

  const [cldLayer, cuLayer, blockLayer] = await Promise.all([
    getLayerInfo(serviceUrl, 3),
    getLayerInfo(serviceUrl, 5),
    getLayerInfo(serviceUrl, 6)
  ]);

  const cldGeojson = enrichFeatureCollection(
    await queryAllFeatures(serviceUrl, 3, `CFOP_CLD_ID='${args.cld}'`, cldLayer.geometryType),
    "cld",
    args.cld
  );

  const cuGeojson = enrichFeatureCollection(
    await queryAllFeatures(serviceUrl, 5, `CFOP_CLD_ID='${args.cld}'`, cuLayer.geometryType),
    "cu",
    args.cld
  );

  const cuCodes = uniqueSorted((cuGeojson.features || []).map((feature) => feature.properties?.cu));
  const cuToClD = new Map(
    (cuGeojson.features || []).map((feature) => [feature.properties?.cu, feature.properties?.cld])
  );

  const blockCollections = [];
  for (const group of chunk(cuCodes, 100)) {
    const where = `CUID IN (${group.map((code) => `'${code}'`).join(",")})`;
    const payload = await queryAllFeatures(serviceUrl, 6, where, blockLayer.geometryType);
    blockCollections.push(...(payload.features || []));
  }

  const blockGeojson = enrichFeatureCollection(
    { type: "FeatureCollection", features: blockCollections },
    "block",
    args.cld,
    cuToClD
  );

  const cldProps = cldGeojson.features[0]?.properties || {};
  const zones = uniqueSorted((cuGeojson.features || []).map((feature) => feature.properties?.zone));
  const blocksByCu = {};
  for (const feature of blockGeojson.features || []) {
    const cu = String(feature.properties?.cu || "").trim();
    if (!cu) continue;
    blocksByCu[cu] = (blocksByCu[cu] || 0) + 1;
  }

  const index = {
    cld: args.cld,
    name: args.cld,
    serviceUrl,
    exportedAt: new Date().toISOString(),
    counts: {
      cld: cldGeojson.features.length,
      cu: cuGeojson.features.length,
      blocks: blockGeojson.features.length
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
    writeJson(path.join(outDir, "cld.geojson"), cldGeojson),
    writeJson(path.join(outDir, "cu.geojson"), cuGeojson),
    writeJson(path.join(outDir, "blocks.geojson"), blockGeojson),
    writeJson(path.join(outDir, "index.json"), index)
  ]);

  process.stdout.write(
    `${JSON.stringify(
      {
        outDir,
        counts: index.counts,
        zones: index.zones,
        cuCodes: index.cuCodes
      },
      null,
      2
    )}\n`
  );
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
