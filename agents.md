# agents.md

## Project Summary

`selfhost-map-cmp` is a self-hosted GIS application for viewing and editing Census regions and dwellings on a dedicated server.

The current product direction is:
- region access by `CLD` route,
- file-based storage per `CLD`,
- viewer and editor pages for each region,
- touch-friendly editing on iPhone,
- server-side image upload and compression for dwelling photos.

## Target User Flows

### Landing

- User opens `/`.
- User enters a `CLD` number or an `SSID`.
- App resolves the input to a `CLD`.
- App redirects to `/<CLD_number>`.

### Viewer

- Route: `/<CLD_number>`.
- Loads `CU`, `Block`, and `dwelling` data only for that `CLD`.
- Shows map and dwelling information.
- Exposes an `Edit` button that opens `/<CLD_number>/edit`.

### Editor

- Route: `/<CLD_number>/edit`.
- Allows adding, editing, moving, and deleting dwellings.
- Allows editing `CU` and `Block` boundaries.
- Allows uploading photos for new or existing dwellings.
- Must remain usable on iPhone Safari.

## Target Data Model

### Region scope

Each `CLD` is a separate storage unit.

Suggested folder:

```text
data/cld/<CLD_number>/
  index.json
  cu.geojson
  blocks.geojson
  dwellings.geojson
  media/
```

### `index.json`

Should contain:
- `cld`,
- accepted `ssid` values,
- display label,
- timestamps/version metadata,
- optional region-level settings.

### `cu.geojson`

- Geometry for the CU area(s) inside the selected `CLD`.
- Editable in the region editor.

### `blocks.geojson`

- Block polygons for the selected `CLD`.
- Editable in the region editor.

### `dwellings.geojson`

- Point features for dwellings in the selected `CLD`.
- Includes dwelling attributes and media references.

### media

- Store original and compressed photos.
- Keep references stable so files survive editing sessions and backups.

## Technical Direction

- Keep the main runtime in `backend/`.
- Prefer region-scoped APIs over one global feature feed.
- Prefer file-based storage for the dedicated server deployment.
- Add authentication before exposing editor routes publicly.
- Add automatic backups for `data/cld/`.

## Important UX Requirements

- Root page must be simple and keyboard-friendly.
- Viewer must load directly from a shareable `/<CLD_number>` URL.
- Editor controls must be touch-friendly on iPhone.
- `Add a dwelling` must support direct camera capture where the browser allows it.
- Users must be able to upload photos without creating a new dwelling.
- Geometry editing must support curved/boundary correction for `CU` and `Block` shapes.

## Current Documentation Sources

- Architecture and structure: `README.md`, `docs/PROJECT_STRUCTURE.md`
- Backlog: `docs/TASKS.md`

## Implementation Note

The repository still contains earlier prototype assets and release artifacts. New implementation work should treat the CLD-scoped dedicated-server design as the source of truth.
