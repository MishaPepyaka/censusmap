#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STORE_JSON="${STORE_JSON:-$ROOT_DIR/data/file-store.json}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/data/tiles/statcan_basemap_202506}"
MIN_ZOOM="${MIN_ZOOM:-10}"
MAX_ZOOM="${MAX_ZOOM:-14}"

if [[ ! -f "$STORE_JSON" ]]; then
  echo "Missing STORE_JSON: $STORE_JSON" >&2
  exit 1
fi

mkdir -p "$OUT_DIR"

read -r MIN_LON MAX_LON MIN_LAT MAX_LAT < <(
  node - <<'NODE' "$STORE_JSON"
const fs = require("fs");
const p = process.argv[2];
const d = JSON.parse(fs.readFileSync(p, "utf8"));
const feats = d.features || [];
let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
function visit(coords) {
  if (!Array.isArray(coords)) return;
  if (coords.length >= 2 && typeof coords[0] === "number" && typeof coords[1] === "number") {
    const lon = coords[0], lat = coords[1];
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
      minLon = Math.min(minLon, lon);
      maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat);
      maxLat = Math.max(maxLat, lat);
    }
    return;
  }
  for (const c of coords) visit(c);
}
for (const f of feats) {
  const g = f.geometry || {};
  const grp = String((f.properties && f.properties._group) || "").toLowerCase();
  if (grp === "cu" || grp === "blocks" || grp === "dwellings") visit(g.coordinates);
}
if (!Number.isFinite(minLon)) {
  console.error("No coordinates found");
  process.exit(1);
}
console.log(`${minLon} ${maxLon} ${minLat} ${maxLat}`);
NODE
)

echo "Bounds from $STORE_JSON"
echo "  lon: $MIN_LON .. $MAX_LON"
echo "  lat: $MIN_LAT .. $MAX_LAT"
echo "Zooms: $MIN_ZOOM..$MAX_ZOOM"
echo "Output: $OUT_DIR"

tile_xy() {
  local lat="$1"
  local lon="$2"
  local z="$3"
  node - <<'NODE' "$lat" "$lon" "$z"
const lat = Number(process.argv[2]);
const lon = Number(process.argv[3]);
const z = Number(process.argv[4]);
const n = 2 ** z;
const x = Math.floor(((lon + 180) / 360) * n);
const latRad = lat * Math.PI / 180;
const y = Math.floor((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2 * n);
console.log(`${x} ${y}`);
NODE
}

TOTAL=0
for ((z=MIN_ZOOM; z<=MAX_ZOOM; z++)); do
  read -r x1 y1 < <(tile_xy "$MAX_LAT" "$MIN_LON" "$z") # NW
  read -r x2 y2 < <(tile_xy "$MIN_LAT" "$MAX_LON" "$z") # SE
  minX=$(( x1 < x2 ? x1 : x2 ))
  maxX=$(( x1 > x2 ? x1 : x2 ))
  minY=$(( y1 < y2 ? y1 : y2 ))
  maxY=$(( y1 > y2 ? y1 : y2 ))
  count=$(( (maxX - minX + 1) * (maxY - minY + 1) ))
  TOTAL=$((TOTAL + count))
  echo "z$z: x ${minX}-${maxX}, y ${minY}-${maxY}, tiles $count"
done
echo "Total tiles: $TOTAL"

done_count=0
skip_count=0
fail_count=0

for ((z=MIN_ZOOM; z<=MAX_ZOOM; z++)); do
  read -r x1 y1 < <(tile_xy "$MAX_LAT" "$MIN_LON" "$z")
  read -r x2 y2 < <(tile_xy "$MIN_LAT" "$MAX_LON" "$z")
  minX=$(( x1 < x2 ? x1 : x2 ))
  maxX=$(( x1 > x2 ? x1 : x2 ))
  minY=$(( y1 < y2 ? y1 : y2 ))
  maxY=$(( y1 > y2 ? y1 : y2 ))

  for ((x=minX; x<=maxX; x++)); do
    mkdir -p "$OUT_DIR/$z/$x"
    for ((y=minY; y<=maxY; y++)); do
      dst="$OUT_DIR/$z/$x/$y.png"
      if [[ -s "$dst" ]]; then
        skip_count=$((skip_count + 1))
        continue
      fi

      url="https://geoprod.statcan.gc.ca/camv1/proxy.ashx?https://geoprod.statcan.gc.ca/geo_wa/rest/services/BASEMAP_202506_EN_Z00_13/MapServer/tile/$z/$y/$x"
      if wget -q -O "$dst.tmp" "$url"; then
        mv "$dst.tmp" "$dst"
        done_count=$((done_count + 1))
      else
        rm -f "$dst.tmp"
        fail_count=$((fail_count + 1))
      fi
    done
  done
done

echo "Downloaded: $done_count"
echo "Skipped existing: $skip_count"
echo "Failed: $fail_count"

if [[ "$fail_count" -gt 0 ]]; then
  exit 2
fi
