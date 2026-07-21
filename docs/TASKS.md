# Tasks

## Current Priority Backlog

- [x] T018 Simplify dwelling details and add status colours
  - Keep only CU, Block, Dwelling No, Status, and Notes in the dwelling form.
  - Make Status a dropdown: 429, 400, 402, 701, 500, 312, 324; default to 429.
  - Colour dwelling map squares by status: white (429), lime (400/402/701), red (500), grey (312/324).

- [ ] T019 Add block sharing and Google Maps actions
  - Show Share Link and Open Google Maps actions when a Block is selected.

- [ ] T020 Use a person emoji for map location
  - Replace the location control icon with a person emoji.

- [ ] T021 Remove zone geometry editing
  - Remove CU/Block geometry editing and its Save Geometry control.

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

- [ ] T017 Improve mobile geometry controls
  - Add larger vertex handles for iPhone.
  - Add explicit touch hints for polygon edit mode.

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
