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

Deploy the checked-out commit with the local production credentials:

```bash
./deploy/dedicated-server/deploy-current.sh
```

Server addresses, SSH commands, passwords, private keys, and deployment-specific options are local-only operational data. Keep them in an ignored file such as `SERVER_ACCESS.md`, `SSH_ACCESS.md`, or `DEPLOYMENT.local.md`; never put them in a tracked document, commit, terminal transcript, or final report.

If the environment has no usable SSH authentication, do not attempt to bypass it or ask for credentials in the repository. Push the verified commit to `origin/main`, state that production deployment is pending because SSH access is unavailable, and stop there. The code is still ready for an operator with production access to deploy.

When deployment access is available, verify the real application health endpoint and the expected deployed asset or text. Report the actual result concisely; do not report a deployment as successful based only on a push.

## Safety

- Never reset, discard, or overwrite unrelated work.
- Avoid destructive commands and database mutations unless the task clearly requires them.
- Keep credentials out of terminal output and final responses.
- If a requirement changes data shape, permissions, or production behaviour beyond the request, inspect first and explain the impact before proceeding.
