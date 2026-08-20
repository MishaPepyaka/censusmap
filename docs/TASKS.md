# Tasks

This is the active rewrite backlog. Completed work and superseded prototype tasks
were removed so that this file contains only work that still needs a decision or
implementation.

## Rewrite principles

1. Keep the existing CLD routes and user-visible behaviour working during the migration.
2. Establish one canonical feature and dwelling model at the API boundary.
3. Use one runtime data store. Legacy stores may be read only by explicit migration tools.
4. Move code in small, independently deployable slices; delete a legacy path only after tests cover its replacement.

## Phase 0 — Baseline and decisions

- [x] R100 Document the production data-store choice and make it explicit in deployment configuration.
  - PostgreSQL/PostGIS is the sole production source of truth; see `docs/DATA_STORE.md`.
  - Production defaults set `USE_FILE_STORE=false`; the file store remains temporary migration/recovery compatibility.
  - R112 will remove its duplicate runtime CRUD after migration verification.

- [ ] R101 Add a test baseline.
  - [x] Add unit tests for CLD/SSID, feature classification, dwelling identity, status normalisation, and JSON persistence.
  - [x] Add isolated file-store API integration coverage for health, lookup, and anonymous access rejection.
  - [x] Add a Chromium smoke test for login and anonymous viewer/editor redirects.
  - [ ] Add PostGIS-backed authenticated CRUD and CLD-access integration coverage.

## Phase 1 — Canonical domain and backend

- [x] R110 Define the canonical API/domain model.
  - [x] Define canonical normalisation for `RegionFeature` and dwelling properties (`cu`, `block`, `dwellingNo`, `status`).
  - [x] Normalise legacy property spellings at the backend input/output boundary while retaining aliases for UI compatibility.
  - [x] Add explicit GeoJSON and CLD-ownership validation in the shared region domain module.

- [ ] R111 Split the Express monolith.
  - [x] Extract Express app setup, middleware, and static asset registration from `backend/src/server.js`.
  - [x] Move auth, regions, users, uploads, system, and tile proxy routes into route modules.
  - [x] Add central error handling.
  - [ ] Move data access and business rules into repositories and services.
    - [x] Move region summary, feature-type classification, and dwelling uniqueness rules into `services/region-service.js`.
    - [ ] Extract persistence adapters into repositories.

- [ ] R112 Consolidate region persistence.
  - [x] Define and wire a single `RegionRepository` interface for region routes.
  - [ ] Move PostGIS and temporary file-store implementations behind dedicated repository adapters.
    - [x] Extract PostGIS existence/index/features read adapter.
  - [x] Isolate legacy `/api/features` CRUD and import compatibility in `legacy-feature-routes.js`.
  - Keep legacy file-store and shared-feature conversion in one-time migration/import scripts only.
  - Remove obsolete `/api/features` CRUD and `map_features` code after migration verification.

- [ ] R113 Add safe concurrent editing.
  - Return a revision/version with each region snapshot.
  - Require the revision for writes and return a conflict response rather than silently overwriting a newer edit.

## Phase 2 — Shared frontend foundation

- [ ] R120 Introduce a frontend module build and typed source layout.
  - Move page scripts from `backend/public/` into `frontend/src/` modules.
  - Keep generated static assets as the only runtime files under `backend/public/`.
  - Convert shared domain, API, map, and offline modules before converting page-specific UI.

- [ ] R121 Create one region data client.
  - Centralise CLD loading, canonical feature parsing, caching, and error handling.
  - Remove duplicate `getMapData`, feature partitioning, identifier extraction, and status normalisation from viewer/editor/StatCan code.

- [ ] R122 Create a common map shell.
  - Share map initialisation, URL state, base maps, tile status, geolocation, feature rendering, and dwelling search indexing.
  - Keep viewer and editor as mode-specific controllers over the same shell.

- [ ] R123 Retire or migrate the standalone StatCan prototype.
  - Decide whether `/statcan` remains a supported product surface.
  - If retained, migrate it to the common region client and map shell; otherwise remove its route and assets.

## Phase 3 — Durable offline work

- [ ] R130 Store CLD snapshots in IndexedDB.
  - Download CU, blocks, dwellings, special locations, snapshot timestamp, and revision per CLD.
  - Render a downloaded snapshot and build search indexes without a network connection.
  - Show clear states for unavailable, downloading, ready, stale, and failed snapshots.

- [ ] R131 Make offline edits durable and synchronised.
  - Store pending mutations in IndexedDB and apply them optimistically to the local snapshot.
  - Retry on application open and connectivity restoration.
  - Surface pending counts and server revision conflicts in the editor.

- [ ] R132 Validate supported offline behaviour.
  - Test initial download, airplane-mode reload, search, editing, restart, reconnect, and conflict resolution on iPhone Safari and Chromium.
  - Document storage limits, recovery, and optional bounded offline tile packages.

## Phase 4 — Product hardening

- [ ] R140 Add a region metadata editor for CLD labels and SSIDs.

- [ ] R141 Provide an operator-safe restore workflow for backups.
  - Add restore validation and documented rollback steps.

- [ ] R142 Remove deprecated routes, static assets, scripts, and deployment variables.
  - Perform this only after the replacement has tests, migration verification, and a production backup.
