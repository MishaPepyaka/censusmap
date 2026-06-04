#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="${ROOT_DIR}/data/cld"
BACKUP_DIR="${ROOT_DIR}/data/backups"
STAMP="$(date +"%Y-%m-%d_%H-%M-%S")"
ARCHIVE_PATH="${BACKUP_DIR}/cld-backup_${STAMP}.tar.gz"

mkdir -p "${BACKUP_DIR}"

if [[ ! -d "${SOURCE_DIR}" ]]; then
  echo "Missing source directory: ${SOURCE_DIR}" >&2
  exit 1
fi

tar -czf "${ARCHIVE_PATH}" -C "${ROOT_DIR}/data" cld
echo "Created ${ARCHIVE_PATH}"
