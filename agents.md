# Agent workflow

## Project map

- Runtime and API: `backend/src/server.js`.
- Viewer: `backend/public/app.js` and `index.html` (`/:cld`).
- Editor: `backend/public/app-edit.js` and `edit.html` (`/:cld/edit`).
- Geometry editor: `app-edit-geometry.js` (`/:cld/edit_geometry`, admin only).
- Shared map UI: `backend/public/styles.css`.
- Backlog: `docs/TASKS.md`.

Treat the running server code and the current database/API behaviour as the source of truth. Some older README/task text describes a previous file-store design and may be stale.

## Working a task

1. Read the relevant UI, API, and existing behaviour before changing it. Check `git status` first; preserve unrelated user changes.
2. Keep viewer and editor behaviour/styles aligned when a feature is visible on both pages.
3. Prefer small, scoped changes. Use `apply_patch` for source edits.
4. For a new UI feature, cover the full path: data load, rendering, interaction, persistence, error state, and cache-busting asset versions when JavaScript or CSS changes.
5. Update `docs/TASKS.md` only when a task is actually completed or when the user asks to manage the backlog.

## Required checks

Before committing, run the checks that apply:

```bash
node --check backend/src/server.js
node --check backend/public/app.js
node --check backend/public/app-edit.js
git diff --check
git status --short --branch
```

Run additional focused tests when available. Do not claim browser or device testing unless it was actually performed.

## Git workflow

1. Stage only files belonging to the task.
2. Make one clear commit per completed change.
3. Push the current commit to production main explicitly:

```bash
git push origin HEAD:main
```

The usual local branch may be named `deploy-work`; do not assume a local `main` branch exists. Confirm the working tree and upstream state after pushing.

## Dedicated deployment

Production target:

- SSH: `root@38.180.12.146`
- Application directory: `/opt/censusmap`
- Health endpoint: `http://127.0.0.1:8080/health`

Deploy the checked-out commit with:

```bash
./deploy/dedicated-server/deploy-current.sh
```

Use the existing approved SSH credential mechanism; never place passwords, private keys, or tokens in tracked files, commits, logs, or documentation.

The deployment script currently probes `/health` without port `8080`, which can report a 404 even after a successful Docker rebuild. Always verify the real endpoint after deployment:

```bash
ssh root@38.180.12.146 'curl -fsS http://127.0.0.1:8080/health'
```

If a frontend feature was deployed, also verify that the expected static asset or text exists under `/opt/censusmap/backend/public/`. Report the actual deployment and health-check result concisely.

## Safety

- Never reset, discard, or overwrite unrelated work.
- Avoid destructive commands and database mutations unless the task clearly requires them.
- Keep credentials out of terminal output and final responses.
- If a requirement changes data shape, permissions, or production behaviour beyond the request, inspect first and explain the impact before proceeding.
