# Project Structure

## Purpose

This file defines the target repository layout for the dedicated-server CLD viewer/editor application.

The main architectural shift is:
- route by `CLD`,
- store region data in separate files per `CLD`,
- keep media files next to region data,
- support viewer and editor flows on desktop and iPhone.

## Canonical Layout

```text
selfhost-map-cmp/
├── backend/                          # Node/Express app
│   ├── src/                          # Server routes, services, upload/compression logic
│   └── public/                       # Frontend assets for landing/view/edit flows
├── data/
│   ├── cld/
│   │   └── <CLD_number>/
│   │       ├── index.json            # CLD metadata, SSID mapping, labels
│   │       ├── cu.geojson            # CU geometry for this CLD
│   │       ├── blocks.geojson        # Block geometry for this CLD
│   │       ├── dwellings.geojson     # Dwelling points and attributes
│   │       └── media/
│   │           ├── dwellings/        # Per-dwelling photo collections
│   │           └── uploads/          # Unattached editor uploads if needed
│   ├── import/                       # Import source files and migration inputs
│   ├── tmp/                          # Temporary processing files
│   └── backups/                      # Snapshot exports or scheduled backups
├── deploy/                           # Nginx, systemd, container, and backup configs
├── docs/                             # Architecture, tasks, and operating notes
├── ios-safari-web/                   # Optional Safari-specific release assets
├── mobile-app/                       # Optional Android wrapper
├── mobile-app-iossafari/             # Optional mobile packaging experiments
├── releases/                         # Versioned build outputs only
├── scripts/                          # Import, migration, backup, and maintenance utilities
├── docker-compose.yml                # Local/dev stack
├── README.md                         # Product and architecture summary
└── agents.md                         # Working context for future coding sessions
```

## Routing Layout

- `/` serves the CLD/SSID lookup page.
- `/:cld` serves the region viewer.
- `/:cld/edit` serves the region editor.
- `/api/cld/:cld/*` serves region-specific data APIs.
- `/api/uploads/*` handles media upload and retrieval.

## Backend Responsibilities

Files that should live under `backend/src/`:
- route handlers for landing, viewer, and editor pages,
- `CLD` resolution service from `CLD` or `SSID`,
- per-CLD file storage service,
- geometry validation service,
- dwelling CRUD service,
- image upload and compression service,
- authentication middleware for edit routes.

## Frontend Responsibilities

Files that should live under `backend/public/`:
- landing page UI for `CLD`/`SSID` lookup,
- region viewer UI with `Edit` entry point,
- region editor UI with touch-friendly controls,
- geometry editor for `CU` and `Block` boundaries,
- dwelling editor with photo upload flow,
- iPhone-safe camera capture controls.

## Data Rules

1. Each `CLD` owns its own folder under `data/cld/`.
2. `CU`, `Block`, and `dwelling` data are never mixed across CLDs in a single shared file.
3. Media files are stored under the same `CLD` folder as their related data.
4. `index.json` is the source of truth for `SSID` to `CLD` resolution.
5. Temporary files must stay in `data/tmp/`.
6. Backups and exports must not overwrite source region files in place.

## Migration Direction

Legacy artifacts currently present in the repository include:
- shared feature stores,
- prototype static HTML routes,
- release-specific standalone variants.

The implementation goal is to migrate runtime behavior to the CLD-scoped structure above while preserving release artifacts as history only.
