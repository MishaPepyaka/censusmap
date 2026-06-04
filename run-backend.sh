#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"
FILE_STORE_PATH="${FILE_STORE_PATH:-$ROOT_DIR/data/file-store.json}"
USE_FILE_STORE="${USE_FILE_STORE:-true}"

if [[ ! -f "$FILE_STORE_PATH" ]]; then
  echo "Data file not found: $FILE_STORE_PATH" >&2
  exit 1
fi

cd "$ROOT_DIR/backend"
export PORT
export FILE_STORE_PATH
export USE_FILE_STORE

echo "Starting backend..."
echo "URL: http://localhost:${PORT}"
echo "API: http://localhost:${PORT}/api/features"
echo "USE_FILE_STORE=${USE_FILE_STORE}"
echo "FILE_STORE_PATH=${FILE_STORE_PATH}"
echo

exec npm start
