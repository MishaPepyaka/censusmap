#!/usr/bin/env bash
set -euo pipefail

if [ $# -lt 1 ]; then
  echo "Usage: $0 /path/to/file.geojson [api_url]"
  exit 1
fi

FILE="$1"
API_URL="${2:-http://localhost:8080}"

if [ ! -f "$FILE" ]; then
  echo "File not found: $FILE"
  exit 1
fi

curl -sS \
  -X POST \
  -H "Content-Type: application/json" \
  --data-binary "@${FILE}" \
  "${API_URL}/api/import/geojson"
echo
