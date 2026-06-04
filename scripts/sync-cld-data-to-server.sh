#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <ssh_target> <remote_app_dir>" >&2
  echo "Example: $0 root@38.180.12.146 /opt/censusmap" >&2
  exit 1
fi

SSH_TARGET="$1"
REMOTE_APP_DIR="$2"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ARCHIVE_PATH="/tmp/censusmap-cld-sync.tgz"

if [[ ! -d "${ROOT_DIR}/data/cld" ]]; then
  echo "Missing local CLD data directory: ${ROOT_DIR}/data/cld" >&2
  exit 1
fi

tar -czf "${ARCHIVE_PATH}" -C "${ROOT_DIR}/data" cld
scp -o StrictHostKeyChecking=accept-new "${ARCHIVE_PATH}" "${SSH_TARGET}:/tmp/censusmap-cld-sync.tgz"
ssh "${SSH_TARGET}" "mkdir -p '${REMOTE_APP_DIR}/data' && tar -xzf /tmp/censusmap-cld-sync.tgz -C '${REMOTE_APP_DIR}/data' && rm -f /tmp/censusmap-cld-sync.tgz"

echo "Synced CLD data to ${SSH_TARGET}:${REMOTE_APP_DIR}/data/cld"
