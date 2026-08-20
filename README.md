# Self-Hosted CLD Map Editor

This repository contains a self-hosted web application for viewing and editing Census map data on a dedicated server.

The new target architecture is:
- root page asks for a `CLD` number or an `SSID`,
- `/<CLD_number>` opens the viewer for that region,
- `/<CLD_number>/edit` opens the editor for that region,
- each CLD stores its own `CU`, `Block`, and `dwelling` data in separate files,
- photo uploads are accepted from mobile devices, compressed server-side, and attached to dwellings or uploaded independently during editing.

## Product Scope

- Dedicated-server deployment only.
- Region-first navigation by `CLD`.
- PostgreSQL/PostGIS storage for CLD metadata and geometry.
- Viewer mode for field use.
- Editor mode for geometry and dwelling maintenance.
- iPhone-compatible editing and camera upload flow.

## Target Routes

- `/`
  - Landing page.
  - Prompts the user to enter a `CLD` number or an `SSID`.
  - Resolves the input to a target `CLD`.
- `/<CLD_number>`
  - Read-only map/region viewer.
  - Loads `CU`, `Block`, and `dwelling` data for the selected `CLD`.
  - Shows an `Edit` button.
- `/<CLD_number>/edit`
  - Region editor.
  - Supports adding, deleting, and updating dwellings.
  - Supports geometry editing for `CU` and `Block` boundaries.
  - Supports photo uploads with and without creating a new dwelling.

## Data Storage Model

Production region data is stored in PostgreSQL/PostGIS. The CLD file structure
is retained for media, import/export, backups, and temporary migration input.

Disk layout for media and migration inputs:

```text
data/
  cld/
    <CLD_number>/
      media/
        dwellings/
          <dwelling_id>/
            original/
            compressed/
        uploads/
          <upload_id>.jpg
```

Rules:
- One folder per `CLD`.
- `SSID` to `CLD` lookup and all region features are read from PostgreSQL/PostGIS.
- GeoJSON files under `data/` are explicit import/export or migration artifacts, not live production data.
- Uploaded photos must be compressed server-side before long-term storage.

## Editing Requirements

- `Add a dwelling` button in editor mode.
- On iPhone, the button must allow taking a photo directly from the camera.
- After capture, the photo is uploaded to the server and compressed.
- The workflow then creates a dwelling or links the photo to an existing draft dwelling.
- Editor also supports uploading photos without creating a new dwelling.
- Editor must allow deleting dwellings.
- Editor must support curve/boundary editing for both `CU` and `Block` geometries.

## Mobile / iPhone Constraints

- Primary target is Safari on iPhone.
- UI controls must be large enough for touch.
- No hover-only interactions.
- Camera/file input must rely on standard mobile browser support.
- Geometry editing must remain usable on a small screen with touch handles and clear save/cancel actions.

## Recommended Backend Responsibilities

- Resolve `CLD` and `SSID` on the landing route.
- Serve region-specific viewer and editor routes.
- Read/write CLD-scoped metadata and geometry through the region repository.
- Validate geometry and dwelling payloads before save.
- Accept image uploads, compress them, and store stable file references.
- Protect edit endpoints with authentication before public deployment.

## Deployment Direction

Recommended production shape for a dedicated server:
- `Node.js` app for routes, APIs, uploads, and static assets,
- `Nginx` as reverse proxy,
- PostgreSQL/PostGIS for region data and local disk storage for uploaded media,
- optional nightly backup to object storage.

## Operational Notes

- PostgreSQL/PostGIS is the production source of truth for region metadata and geometry; see [docs/DATA_STORE.md](docs/DATA_STORE.md).
- Set `USE_FILE_STORE=false` in production. File-store mode is temporary migration/recovery compatibility only.
- Set `EDIT_USERNAME` and `EDIT_PASSWORD` to protect `/<CLD_number>/edit` and write APIs with HTTP Basic auth.
- Use `scripts/backup-cld-data.sh` to archive media and CLD import/export files. Back up PostgreSQL separately.

## Current Status

The repository still contains earlier prototype paths and storage files. This document defines the target architecture to migrate toward in the next implementation cycle.
