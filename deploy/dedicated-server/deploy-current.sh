#!/usr/bin/env bash
set -euo pipefail

# Deploy the currently checked-out commit. Set SSH_OPTIONS, for example:
# SSH_OPTIONS='-i ~/.ssh/censusmap_ed25519' ./deploy-current.sh
SSH_TARGET="${1:-root@38.180.12.146}"
REMOTE_APP_DIR="${2:-/opt/censusmap}"
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
COMMIT="$(git -C "${ROOT_DIR}" rev-parse --short HEAD)"
ARCHIVE_PATH="/tmp/censusmap-deploy-${COMMIT}.tgz"
SSH_OPTIONS="${SSH_OPTIONS:--o StrictHostKeyChecking=accept-new}"

cleanup() {
  rm -f "${ARCHIVE_PATH}"
}
trap cleanup EXIT

git -C "${ROOT_DIR}" archive --format=tar.gz -o "${ARCHIVE_PATH}" HEAD
# shellcheck disable=SC2086
scp ${SSH_OPTIONS} "${ARCHIVE_PATH}" "${SSH_TARGET}:/tmp/censusmap-deploy-${COMMIT}.tgz"
# shellcheck disable=SC2086
ssh ${SSH_OPTIONS} "${SSH_TARGET}" "cd '${REMOTE_APP_DIR}' && tar -xzf '/tmp/censusmap-deploy-${COMMIT}.tgz' && docker compose up --build -d --remove-orphans && curl -fsS http://127.0.0.1/health"

echo "Deployed ${COMMIT} to ${SSH_TARGET}:${REMOTE_APP_DIR}"
