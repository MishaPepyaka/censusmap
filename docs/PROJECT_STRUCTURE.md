# Project Structure

## Purpose

This document defines the target layout after the duplication-reduction rewrite.
The current runtime is still centred on `backend/src/server.js` and static scripts
in `backend/public/`; this is the destination, not a claim that the migration is
complete.

PostgreSQL/PostGIS is the selected production source of truth for region
metadata and geometry. See [DATA_STORE.md](DATA_STORE.md) for the migration and
backup boundary.

## Target Layout

```text
selfhost-map-cmp/
├── backend/
│   ├── src/
│   │   ├── app.ts                    # Express app composition
│   │   ├── server.ts                 # HTTP startup only
│   │   ├── config/                   # validated environment configuration
│   │   ├── domain/                   # canonical GeoJSON, dwelling, CLD types/rules
│   │   ├── middleware/               # auth, access control, errors
│   │   ├── repositories/             # selected runtime persistence adapter
│   │   ├── routes/                   # auth, regions, users, uploads, tiles
│   │   └── services/                 # region, lookup, upload, revision services
│   ├── public/                       # generated frontend assets and static media only
│   ├── test/                         # API and service integration tests
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── api/                      # typed HTTP clients
│   │   ├── domain/                   # client-side canonical model helpers
│   │   ├── map/                      # Leaflet shell, rendering, search index
│   │   ├── offline/                  # IndexedDB snapshots and mutation queue
│   │   ├── pages/                    # landing, viewer, editor, geometry editor
│   │   ├── ui/                       # shared controls, panels, popup components
│   │   └── styles/                   # tokens and component/page styles
│   ├── test/                         # unit and browser-facing tests
│   └── package.json
├── data/
│   ├── import/                       # source files and explicit migration inputs
│   ├── tmp/                          # disposable processing output
│   └── backups/                      # timestamped, restorable backups
├── scripts/                          # import, migration, audit, backup, restore tools
├── deploy/                           # Docker, Nginx, production deployment material
├── docs/                             # architecture and active backlog
├── docker-compose.yml
├── README.md
└── agents.md
```

## Ownership Boundaries

| Area | Owns | Must not own |
| --- | --- | --- |
| `domain/` | Data types, normalisation, validation, feature classification | HTTP, database/filesystem, DOM/Leaflet |
| `repositories/` | Reads and writes for the selected runtime store | Express request handling or business policy |
| `services/` | Use cases: region CRUD, lookup, upload, conflict detection | Route registration or UI rendering |
| `routes/` | Request parsing, response status, calling services | SQL/filesystem code and duplicated validation |
| `frontend/api/` | API requests and response mapping | Leaflet/UI state |
| `frontend/map/` | Shared map lifecycle and feature rendering | Page-specific edit forms |
| `frontend/pages/` | Viewer/editor flow and page-specific interaction | Duplicate loading, offline, and map setup |

## Data Model Rules

1. The API exposes one canonical feature shape; legacy field names are converted only during import or at the backend boundary.
2. A region has a revision. Writes include the expected revision so conflicts are explicit.
3. Exactly one repository is the runtime source of truth. A second store is permitted only for backup, import, export, or one-time migration.
4. CLD access is checked in middleware/services before a repository operation.
5. Uploaded media is scoped to a CLD and referenced by a stable media identifier, never by arbitrary client path.

## Routing Layout

- `/` — authenticated CLD/SSID lookup.
- `/:cld` — region viewer.
- `/:cld/edit` — region editor.
- `/:cld/edit_geometry` — geometry editor, if retained.
- `/api/cld/:cld/*` — region-scoped API.
- `/api/*` — authentication, user management, uploads, configuration, and tile proxy APIs.

## Migration Rules

1. Preserve existing routes while their replacement is introduced behind the same API contract.
2. Add tests before moving or deleting behaviour.
3. Migrate one vertical slice at a time: domain rule, service, route, frontend caller, then removal of the old path.
4. Do not delete legacy data or routes until import verification and a restorable backup exist.
