# Data Store Decision

## Decision

PostgreSQL with PostGIS is the sole runtime source of truth for production
region metadata and GeoJSON features.

`USE_FILE_STORE=false` is the production default. The `data/cld/` directory
continues to hold uploaded media, imports, exports, and backups, but its
GeoJSON files are not a second live feature store in production.

## Temporary Compatibility Mode

`USE_FILE_STORE=true` remains supported only while the legacy data migration is
being retired. It is intended for local recovery and migration verification,
not for normal production operation. It must be explicitly set; no deployment
configuration enables it by default.

## Operational Responsibilities

| Data | Authoritative location | Backup/restore path |
| --- | --- | --- |
| CLD metadata and region features | PostgreSQL/PostGIS | database backup and restore procedure |
| Uploaded media | `data/cld/<cld>/media/` | `scripts/backup-cld-data.sh` archive |
| Import/export inputs | `data/import/` | retain separately from runtime data |
| Legacy GeoJSON/file store | migration input only | preserve until R112 migration verification |

## Migration Guardrails

1. Import existing CLD files with `npm run import:cld:db` before switching a deployment to PostGIS mode.
2. Verify region counts, dwelling identities, and media references after import.
3. Take a database backup and a `data/cld/` archive before removing a legacy store.
4. R112 may remove file-store CRUD only after these checks are automated and documented.
