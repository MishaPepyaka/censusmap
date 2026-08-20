export function registerPageRoutes(app, {
  getUser, normalizeClD, publicDir, regionExists, requireAdmin, requireAuth,
  requireClDAccess, requireUserManagementAccess
}) {
  app.get("/login", (_req, res) => res.sendFile(`${publicDir}/login.html`));
  app.get("/users", requireUserManagementAccess, (_req, res) => res.sendFile(`${publicDir}/users.html`));
  app.get("/", async (req, res) => {
    if (!(await getUser(req))) return res.redirect("/login");
    return res.sendFile(`${publicDir}/landing.html`);
  });
  app.get("/:cld/edit", requireAuth, requireClDAccess, async (req, res, next) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return next();
    if (!(await regionExists(cld))) return res.status(404).sendFile(`${publicDir}/landing.html`);
    return res.sendFile(`${publicDir}/edit.html`);
  });
  app.get("/:cld/edit_geometry", requireAdmin, async (req, res, next) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return next();
    if (!(await regionExists(cld))) return res.status(404).sendFile(`${publicDir}/landing.html`);
    return res.sendFile(`${publicDir}/edit-geometry.html`);
  });
  return (app) => app.get("/:cld", requireAuth, requireClDAccess, async (req, res, next) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return next();
    if (!(await regionExists(cld))) return res.status(404).sendFile(`${publicDir}/landing.html`);
    return res.sendFile(`${publicDir}/index.html`);
  });
}
