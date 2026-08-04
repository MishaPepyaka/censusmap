# Tasks

## Refactoring Roadmap

- [x] R001 Extract shared GeoJSON and display helpers
  - Move identical pure helpers from viewer and editor to `map-data-helpers.js`.
  - Keep page-specific dwelling/block fallback rules in their current page scripts.
  - Load the shared script before viewer/editor code and include it in the offline shell.

- [x] R002 Extract shared API client
  - Centralise JSON response parsing, HTTP errors, and timeout handling.
  - Keep editor queue retry policy separate from simple viewer reads.

- [x] R003 Extract map action popups
  - Share Google Maps, Apple Maps, Share Link markup and copy feedback.
  - Preserve each page's popup-specific content and edit controls.

- [x] R004 Extract shared map setup and location tracking
  - Share URL zoom/coordinate state, base-layer switching, tile-cache status, and browser/Capacitor location tracking.
  - Leave editor modes and marker mutation handling in the editor.

- [x] R005 Consolidate offline loading primitives
  - Share snapshot reading/writing and timeout-safe map loading primitives.
  - Keep the editor's mutation queue and optimistic overlay as an editor-specific layer.

- [x] R006 Organise shared CSS components
  - Group base tokens, map overlays, panels/forms, popups, and responsive rules into component sections or files.
  - Remove literal duplicate declarations without changing visual behaviour.

- [ ] R007 Align geometry editor with shared map infrastructure
  - Decide whether the geometry editor should use the same same-origin tile buffer and API helper.
  - Keep boundary-editing interactions isolated from viewer/editor marker logic.

## Current Priority Backlog

- [x] T025 Add offline-ready app shell for viewer and editor
  - Register the service worker from both `/:cld` and `/:cld/edit`.
  - Cache the route shell, JavaScript, CSS, Leaflet, icons, and other same-origin static assets.
  - Serve a cached route shell for `/:cld` and `/:cld/edit` when the device is offline.
  - Add a visible offline/last-updated status instead of a browser network error.

- [ ] T026 Download and use an offline CLD snapshot
  - Add a `Download for offline` action for the currently open CLD.
  - Store the CU and Block geometry, dwellings, special locations, a snapshot timestamp, and data revision in IndexedDB.
  - Use the local snapshot first on viewer and editor; refresh it in the background when online.
  - Render the CLD area, dwellings, and special locations from the snapshot without a network connection.
  - Build the dwelling/SSID search index from the local snapshot so search works offline.
  - Provide clear states for not downloaded, downloading, ready offline, stale, and failed download.

- [ ] T027 Make offline edits durable and safely synchronised
  - Move the pending mutation queue from `localStorage` to IndexedDB.
  - Apply an edit optimistically to the local CLD snapshot before queuing it.
  - Retry queued writes on application open and when connectivity returns; do not depend only on Background Sync.
  - Add server-side revision/conflict handling so a later remote edit is not silently overwritten.
  - Show the number of pending changes and any sync conflict in the editor.

- [ ] T028 Add an optional offline map background
  - Keep CU/Block geometry and all markers usable without map tiles as the baseline offline map.
  - Host a bounded, same-origin tile package for selected CLDs and zoom levels; do not rely on caching third-party Esri or OpenStreetMap tiles.
  - Download/cache the selected tile package with the CLD snapshot and report its size before download.
  - Allow users to remove a downloaded CLD and its tiles to reclaim storage.

- [ ] T029 Validate offline mode on target browsers
  - Test first download while online, reload in airplane mode, search, map navigation, and special-location visibility on iPhone Safari and Chromium.
  - Test offline editing, restart before reconnecting, reconnect, successful sync, and conflict reporting.
  - Request persistent browser storage where supported and display available/used storage.
  - Document the supported offline scope, storage limits, and recovery steps.

- [x] T018 Simplify dwelling details and add status colours
  - Keep only CU, Block, Dwelling No, Status, and Notes in the dwelling form.
  - Make Status a dropdown: 429, 400, 402, 701, 500, 312, 324; default to 429.
  - Colour dwelling map squares by status: white (429), lime (400/402/701), red (500), grey (312/324).

- [x] T019 Add zone sharing and Google Maps actions
  - Show Share Link and Google Maps actions when a CU or Block is selected.

- [x] T020 Use a custom person marker for map location
  - Replace the temporary CSS person with the supplied SVG marker.

- [x] T021 Remove zone geometry editing
  - Remove CU/Block geometry editing and its Save Geometry control.

- [x] T022 Streamline the editor panel
  - Auto-save a dwelling when its Status changes.
  - Remove Quick Actions for photo upload and adding a dwelling.
  - Move the editor panel closer to the left edge.

- [x] T023 Cycle through duplicate dwelling search matches
  - Show the first SSID match on the first search.
  - Advance to the next matching dwelling on each repeated search.
  - Reset to the first match when the search text changes.

- [x] T024 Simplify viewer navigation
  - Remove the CLD search from the map viewer.
  - Add a Back link next to Edit Region.

- [x] T003 Add CLD-based routing
  - Serve `/` as the lookup page.
  - Serve `/:cld` as the viewer route.
  - Serve `/:cld/edit` as the editor route.
  - Reject unknown `CLD` values with a clear error page.

- [x] T004 Add CLD and SSID lookup flow
  - Build a landing page that accepts either `CLD` or `SSID`.
  - Resolve `SSID` to `CLD` using region metadata.
  - Redirect the user to `/:cld` after a successful lookup.

- [x] T005 Move to per-CLD file storage
  - Create `data/cld/<CLD_number>/`.
  - Store `cu.geojson`, `blocks.geojson`, and `dwellings.geojson` separately.
  - Add `index.json` metadata for each `CLD`.
  - Add migration logic from legacy shared files.

- [x] T006 Add region-scoped data API
  - Add read endpoints for `CU`, `Block`, and `dwelling` data by `CLD`.
  - Add write endpoints scoped to one `CLD`.
  - Validate that writes do not cross region boundaries.

- [x] T007 Add viewer entry to editor
  - Add an `Edit` button on the region viewer page.
  - Preserve the current `CLD` when switching to editor mode.

- [x] T008 Add dwelling CRUD in editor
  - Create dwellings in the active `CLD`.
  - Delete dwellings from the active `CLD`.
  - Edit dwelling attributes and coordinates.
  - Keep numbering and identifiers consistent.

- [x] T009 Add `Add a dwelling` mobile photo flow
  - Add an `Add a dwelling` button in editor mode.
  - On iPhone, allow direct camera capture through file input.
  - Upload the photo immediately after capture.
  - Compress the image server-side.
  - Create a dwelling draft linked to the uploaded photo.

- [x] T010 Add standalone photo uploads in editor
  - Allow photo uploads without creating a new dwelling.
  - Store unattached uploads safely until linked or discarded.
  - Add UI to attach uploaded media to an existing dwelling.

- [x] T011 Add geometry editor for CU and Block boundaries
  - Support touch-friendly boundary editing on iPhone.
  - Allow vertex add, move, and delete operations.
  - Save edited `CU` and `Block` geometry back to per-CLD files.
  - Prevent invalid polygon saves where practical.

- [x] T012 Make the editor iPhone-safe
  - Increase target sizes for touch controls.
  - Remove hover-only interactions.
  - Test viewer and editor flows in Safari on iPhone.
  - Make camera, upload, and geometry actions usable on a small screen.

- [x] T013 Add edit-route authentication
  - Protect `/:cld/edit` and write APIs.
  - Use a simple password or session-based gate first.
  - Keep viewer routes public if required.

- [x] T014 Add backups for CLD data and media
  - Back up `data/cld/` on a schedule.
  - Include geometry, metadata, and uploaded photos.
  - Make restore steps explicit.

## Follow-up Hardening

- [ ] T015 Add region metadata editor
  - Edit `SSID` values and CLD labels from the UI.
  - Persist updates back to `index.json`.

- [ ] T016 Add backup restore workflow
  - Add a restore script for archives created by `scripts/backup-cld-data.sh`.
  - Document rollback steps for a bad edit session.

- [x] T017 Retire mobile geometry controls
  - Superseded by T021: CU and Block geometry editing was removed from the editor.

## Done

- [x] T001 Add dwellings by click
- [x] T002 Validate dwelling number uniqueness on save

## Queue Script

Use:

```bash
cd /home/misha/Projects/selfhost-map-cmp

python3 scripts/task_queue.py list
python3 scripts/task_queue.py next
python3 scripts/task_queue.py done T003
python3 scripts/task_queue.py undo T003
python3 scripts/task_queue.py run --cmd 'echo "DO {task_id}: {task_title}"'
```
