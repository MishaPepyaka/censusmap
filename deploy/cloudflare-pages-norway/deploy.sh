#!/usr/bin/env bash
set -euo pipefail

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  echo "Error: set CLOUDFLARE_API_TOKEN first"
  echo "Example: export CLOUDFLARE_API_TOKEN='your-token'"
  exit 1
fi

cd "$(dirname "$0")"
npx wrangler pages deploy . --project-name norway-house-census-map
