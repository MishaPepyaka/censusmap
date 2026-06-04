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
- File-based geometry and dwelling storage per `CLD`.
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

Data should move to a file-based region structure instead of a single mixed feature store.

Suggested canonical layout:

```text
data/
  cld/
    <CLD_number>/
      index.json              # CLD metadata, SSID mappings, labels, version
      cu.geojson              # CU geometry for this CLD
      blocks.geojson          # Block geometry for this CLD
      dwellings.geojson       # Dwelling points and attributes for this CLD
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
- `SSID` to `CLD` lookup is resolved through metadata, not hard-coded routes.
- `CU`, `Block`, and `dwelling` files are loaded only for the requested `CLD`.
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
- Read/write per-CLD GeoJSON and metadata files.
- Validate geometry and dwelling payloads before save.
- Accept image uploads, compress them, and store stable file references.
- Protect edit endpoints with authentication before public deployment.

## Deployment Direction

Recommended production shape for a dedicated server:
- `Node.js` app for routes, APIs, uploads, and static assets,
- `Nginx` as reverse proxy,
- local disk storage under `data/cld/`,
- optional nightly backup to object storage.

## Operational Notes

- The runtime stack is file-store only; Postgres is not required for production.
- Set `EDIT_USERNAME` and `EDIT_PASSWORD` to protect `/<CLD_number>/edit` and write APIs with HTTP Basic auth.
- Use `scripts/backup-cld-data.sh` to create a compressed snapshot of `data/cld/`.
- Use `scripts/sync-cld-data-to-server.sh <ssh_target> <remote_app_dir>` to publish local `data/cld/` to the server.
- On first startup, the server migrates legacy shared feature data into `data/cld/` if no CLD folders exist yet.

## Current Status

The repository still contains earlier prototype paths and storage files. This document defines the target architecture to migrate toward in the next implementation cycle.
