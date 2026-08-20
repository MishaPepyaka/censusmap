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

- [x] R101 Add a test baseline.
  - [x] Add unit tests for CLD/SSID, feature classification, dwelling identity, status normalisation, and JSON persistence.
  - [x] Add isolated file-store API integration coverage for health, lookup, and anonymous access rejection.
  - [x] Add a Chromium smoke test for login and anonymous viewer/editor redirects.
  - [x] Add opt-in PostGIS-backed authenticated CRUD and CLD-access integration coverage.
    - Set `POSTGRES_TEST_URL` to a dedicated database whose name contains `test`; the suite skips safely otherwise.

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
    - [x] Move region feature mutation validation and storage orchestration into `services/region-service.js`.
    - [x] Move user identity lookups used by authentication into `repositories/user-repository.js`.
    - [ ] Extract persistence adapters into repositories.

- [ ] R112 Consolidate region persistence.
  - [x] Define and wire a single `RegionRepository` interface for region routes.
  - [x] Centralise file-store/PostGIS selection and normalize their persistence interfaces in a region storage adapter.
  - [ ] Move PostGIS and temporary file-store implementations behind dedicated repository adapters.
    - [x] Extract PostGIS existence/index/features read adapter.
    - [x] Extract PostGIS region-index write adapter.
    - [x] Extract PostGIS feature-collection replacement transaction.
    - [x] Extract PostGIS feature lookup by ID.
    - [x] Extract PostGIS feature creation.
    - [x] Extract PostGIS feature update.
    - [x] Extract PostGIS feature deletion.
    - [x] Extract PostGIS region bundle loading.
    - [x] Extract PostGIS CU-code synchronisation.
    - [x] Extract PostGIS CLD record initialisation.
    - [x] Extract PostGIS and file-store CLD catalog loading.
    - [x] Extract PostGIS and file-store CLD/CU/SSID lookup resolution.
    - [x] Extract PostGIS and file-store feature lookup by ID.
    - [x] Extract PostGIS and file-store feature creation.
    - [x] Extract PostGIS and file-store feature update.
    - [x] Extract PostGIS and file-store feature deletion.
    - [x] Extract temporary file-store existence/index/features/bundle read adapter.
    - [x] Extract temporary file-store index and feature-collection write adapter.
    - [x] Extract temporary file-store region initialisation and media-directory handling.
  - [x] Isolate legacy `/api/features` CRUD and import compatibility in `legacy-feature-routes.js`.
  - Keep legacy file-store and shared-feature conversion in one-time migration/import scripts only.
  - Remove obsolete `/api/features` CRUD and `map_features` code after migration verification.

- [x] R113 Add safe concurrent editing.
  - [x] Return a revision/version with each region snapshot.
  - [x] Require the revision for writes and return a conflict response rather than silently overwriting a newer edit.

## Phase 2 — Shared frontend foundation

- [ ] R120 Introduce a frontend module build and typed source layout.
  - [x] Establish a Vite build, TypeScript type-checking, and `frontend/src/` source layout.
  - [ ] Move page scripts from `backend/public/` into `frontend/src/` modules.
    - [x] Migrate the landing-page controller.
    - [x] Migrate the shared authentication widget.
    - [x] Migrate the login-page controller.
    - [x] Migrate the viewer-page controller.
    - [x] Migrate the editor-page controller.
    - [x] Migrate the geometry-editor controller.
  - Keep generated static assets as the only runtime files under `backend/public/`.
  - [ ] Convert shared domain, API, map, and offline modules before converting page-specific UI.
    - [x] Convert the shared API client while preserving `window.CensusMapApi` for existing pages.
    - [x] Convert shared map-data helpers while preserving `window.CensusMapData` for existing pages.
    - [x] Convert the shared offline snapshot store while preserving `window.CldOfflineStore` for existing pages.
    - [x] Convert shared map-action controls while preserving `window.CensusMapActions` for existing pages.
    - [x] Convert shared map runtime while preserving `window.CensusMapRuntime` for existing pages.

- [ ] R121 Create one region data client.
  - [x] Centralise viewer/editor CLD snapshot loading, revision extraction, feature partitioning, offline-cache fallback, and load errors.
  - [x] Centralise viewer/editor dwelling status and CLD feature identifier normalisation.
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
  - [x] Persist each downloaded CLD GeoJSON snapshot with its timestamp and server revision.
  - Download CU, blocks, dwellings, special locations, snapshot timestamp, and revision per CLD.
  - Render a downloaded snapshot and build search indexes without a network connection.
  - Show clear states for unavailable, downloading, ready, stale, and failed snapshots.

- [ ] R131 Make offline edits durable and synchronised.
  - [x] Persist and restore the CLD pending-mutation queue through IndexedDB, with localStorage compatibility fallback.
  - [x] Apply the restored pending-mutation queue optimistically whenever a CLD snapshot is loaded.
  - [x] Show editor pending counts and pause retries with the current server revision after a write conflict.
  - [x] Retry queued editor and geometry changes on application open and connectivity restoration.
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
