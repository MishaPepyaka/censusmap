# Deployment policy

The deployable source of truth is `origin/main`.

1. Verify the relevant code changes locally.
2. Commit only the task files and push with `git push origin HEAD:main`.
3. Deploy only from an environment that already has authorised production SSH access.
4. Verify the running application health endpoint after deployment.

If SSH authentication is unavailable, the correct outcome is: code pushed to `origin/main`; production deployment pending. Do not add passwords, private keys, server addresses, or SSH setup to Git to work around this.

Operational connection details belong in ignored local files such as `SERVER_ACCESS.md`, `SSH_ACCESS.md`, or `DEPLOYMENT.local.md`. Shared workflow belongs in this file and `agents.md`.
