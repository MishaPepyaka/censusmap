#!/usr/bin/env node
import fs from "node:fs/promises";

function usage() {
  console.error("Usage: node convert-esri-json-to-geojson.mjs <input-esri-json> <output-geojson>");
  process.exit(1);
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
    const intersects = ((yi > y) !== (yj > y))
      && (x < ((xj - xi) * (y - yi)) / ((yj - yi) || Number.EPSILON) + xi);
    if (intersects) inside = !inside;
  }
  return inside;
}

function closeRing(ring) {
  if (ring.length === 0) return ring;
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first[0] === last[0] && first[1] === last[1]) return ring;
  return [...ring, first];
}

function convertPolygonRings(rings) {
  const prepared = rings
    .filter((r) => Array.isArray(r) && r.length >= 4)
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
  return { type: "MultiPolygon", coordinates: outers.map((poly) => [poly[0], ...poly.slice(1)]) };
}

function convertGeometry(feature, geometryType) {
  const g = feature?.geometry;
  if (!g) return null;

  if (geometryType === "esriGeometryPoint") {
    return { type: "Point", coordinates: [g.x, g.y] };
  }

  if (geometryType === "esriGeometryPolyline") {
    if (!Array.isArray(g.paths)) return null;
    if (g.paths.length === 1) return { type: "LineString", coordinates: g.paths[0] };
    return { type: "MultiLineString", coordinates: g.paths };
  }

  if (geometryType === "esriGeometryPolygon") {
    if (!Array.isArray(g.rings)) return null;
    return convertPolygonRings(g.rings);
  }

  return null;
}

async function main() {
  const input = process.argv[2];
  const output = process.argv[3];
  if (!input || !output) usage();

  const raw = await fs.readFile(input, "utf8");
  const esri = JSON.parse(raw);

  if (!Array.isArray(esri.features)) {
    throw new Error("Input file does not contain ArcGIS features array");
  }

  const geometryType = esri.geometryType;
  const features = esri.features
    .map((f) => {
      const geometry = convertGeometry(f, geometryType);
      if (!geometry) return null;
      return {
        type: "Feature",
        properties: f.attributes || {},
        geometry
      };
    })
    .filter(Boolean);

  const geojson = {
    type: "FeatureCollection",
    features
  };

  await fs.writeFile(output, JSON.stringify(geojson));

  console.log(`Converted: ${features.length} features`);
  if (esri.exceededTransferLimit) {
    console.log("Warning: exceededTransferLimit=true (input likely partial dataset)");
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
