#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PORT="${PORT:-8080}"

echo "Viewer page: http://localhost:${PORT}/"
exec "$ROOT_DIR/run-backend.sh"
