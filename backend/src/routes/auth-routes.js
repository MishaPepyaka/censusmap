export function registerAuthRoutes(app, {
  authCookie,
  bcrypt,
  findUserByUsername,
  getUser,
  isAdminUser,
  jwt,
  jwtSecret,
  loadUserById,
  mapConfig,
  normalizeUserRole,
  requireAuth,
  secureCookies
}) {
  app.post("/api/login", async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    if (typeof findUserByUsername !== "function") {
      return res.status(503).json({ error: "Authentication is unavailable in file-store mode. Start with PostGIS to sign in." });
    }
    try {
      const user = await findUserByUsername(username);
      if (!user) return res.status(401).json({ error: "Invalid credentials" });
      if (!(await bcrypt.compare(password, user.password_hash))) return res.status(401).json({ error: "Invalid credentials" });
      const token = jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: "30d" });
      res.cookie(authCookie, token, { httpOnly: true, secure: secureCookies, maxAge: 30 * 24 * 60 * 60 * 1000 });
      const authUser = await loadUserById(user.id);
      return res.json({ ok: true, user: authUser || {
        id: user.id, username: user.username, isAdmin: Boolean(user.is_admin), role: normalizeUserRole(user.role)
      } });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/logout", (_req, res) => {
    res.clearCookie(authCookie);
    res.json({ ok: true });
  });

  app.get("/api/me", async (req, res) => {
    const user = await getUser(req);
    if (!user) return res.status(401).json({ error: "Not logged in" });
    return res.json({ user });
  });

  app.get("/api/config", requireAuth, (req, res) => {
    res.json({
      ...mapConfig,
      auth: {
        editProtected: true,
        isAdmin: req.user.isAdmin,
        role: req.user.role,
        canManageUsers: isAdminUser(req.user) || req.user.role === "crew_leader",
        canEdit: isAdminUser(req.user) || req.user.role === "crew_leader"
      }
    });
  });
}
