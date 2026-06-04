#!/usr/bin/env bash
set -euo pipefail

PORT="${PORT:-8080}"

if ! command -v lsof >/dev/null 2>&1; then
  echo "lsof is required for stop-backend.sh" >&2
  exit 1
fi

PIDS="$(lsof -ti tcp:"$PORT" || true)"

if [[ -z "$PIDS" ]]; then
  echo "No process is listening on port $PORT."
  exit 0
fi

echo "Stopping process(es) on port $PORT: $PIDS"
kill $PIDS
echo "Done."
