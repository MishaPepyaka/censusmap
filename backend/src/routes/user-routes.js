export function registerUserRoutes(app, {
  bcrypt, getCrewLeaderIdsForUser, getCrewLeaderUsersForUser, getDirectAllowedClds,
  getManagedUserIds, getManagedUsersForCrewLeader, isAdminUser, normalizeUserRole,
  pool, requireUserManagementAccess, resolveUserIdsFromRefs
}) {
  app.get("/api/admin/users", requireUserManagementAccess, async (req, res) => {
    try {
      const currentUser = req.user;
      const managedIds = await getManagedUserIds(currentUser);
      const { rows } = await pool.query("SELECT id, username, is_admin, role, created_at FROM users ORDER BY username;");
      const visibleRows = isAdminUser(currentUser) ? rows : rows.filter((row) => managedIds.includes(row.id));
      const users = await Promise.all(visibleRows.map(async (row) => ({
        id: row.id, username: row.username, isAdmin: Boolean(row.is_admin || row.role === "admin"),
        role: normalizeUserRole(row.role || (row.is_admin ? "admin" : "enumerator")), createdAt: row.created_at,
        allowedClds: await getDirectAllowedClds(row.id), crewLeaderIds: await getCrewLeaderIdsForUser(row.id),
        crewLeaders: await getCrewLeaderUsersForUser(row.id),
        managedUserIds: row.role === "crew_leader" ? await getManagedUsersForCrewLeader(row.id) : []
      })));
      res.json({ users });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });

  app.post("/api/admin/users", requireUserManagementAccess, async (req, res) => {
    const { username, password, isAdmin, role, allowedClds, crewLeaderIds } = req.body;
    if (!username || !password) return res.status(400).json({ error: "Username and password required" });
    try {
      const currentUser = req.user;
      const resolvedRole = isAdmin ? "admin" : normalizeUserRole(role);
      if (!isAdminUser(currentUser) && resolvedRole !== "enumerator") return res.status(403).json({ error: "Crew leaders can only create enumerators" });
      const hash = await bcrypt.hash(password, 10);
      const { rows } = await pool.query("INSERT INTO users (username, password_hash, is_admin, role) VALUES ($1, $2, $3, $4) RETURNING id;", [username, hash, Boolean(isAdmin), resolvedRole]);
      const userId = rows[0].id;
      if (isAdminUser(currentUser) && Array.isArray(allowedClds) && resolvedRole !== "admin") {
        for (const cld of allowedClds) await pool.query("INSERT INTO user_clds (user_id, cld) VALUES ($1, $2);", [userId, cld]);
      }
      const crewLeaderSet = new Set();
      if (!isAdminUser(currentUser)) crewLeaderSet.add(Number(currentUser.id));
      else if (Array.isArray(crewLeaderIds)) for (const crewLeaderId of await resolveUserIdsFromRefs(crewLeaderIds)) crewLeaderSet.add(crewLeaderId);
      for (const crewLeaderId of crewLeaderSet) await pool.query("INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;", [userId, crewLeaderId]);
      res.status(201).json({ ok: true, userId });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.put("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
    const userId = Number(req.params.id);
    const { password, isAdmin, role, allowedClds, crewLeaderIds } = req.body;
    try {
      const currentUser = req.user;
      const { rows: targetRows } = await pool.query("SELECT id, username, is_admin, role FROM users WHERE id = $1 LIMIT 1;", [userId]);
      if (targetRows.length === 0) return res.status(404).json({ error: "User not found" });
      const target = targetRows[0];
      const targetRole = normalizeUserRole(target.role || (target.is_admin ? "admin" : "enumerator"));
      const managedIds = new Set(await getManagedUserIds(currentUser));
      if (!isAdminUser(currentUser) && !managedIds.has(userId)) return res.status(403).json({ error: "You cannot manage this user" });
      if (!isAdminUser(currentUser) && userId !== Number(currentUser.id) && targetRole !== "enumerator") return res.status(403).json({ error: "Crew leaders can only manage enumerators" });
      const nextRole = isAdmin ? "admin" : normalizeUserRole(role || targetRole);
      if (!isAdminUser(currentUser) && nextRole !== targetRole) return res.status(403).json({ error: "Crew leaders cannot change user roles" });
      if (password) await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2;", [await bcrypt.hash(password, 10), userId]);
      await pool.query("UPDATE users SET is_admin = $1, role = $2 WHERE id = $3;", [Boolean(nextRole === "admin"), nextRole, userId]);
      if (isAdminUser(currentUser)) {
        await pool.query("DELETE FROM user_clds WHERE user_id = $1;", [userId]);
        if (Array.isArray(allowedClds) && nextRole !== "admin") for (const cld of allowedClds) await pool.query("INSERT INTO user_clds (user_id, cld) VALUES ($1, $2);", [userId, cld]);
        await pool.query("DELETE FROM user_crew_leaders WHERE user_id = $1;", [userId]);
        if (Array.isArray(crewLeaderIds) && nextRole === "enumerator") for (const crewLeaderId of await resolveUserIdsFromRefs(crewLeaderIds)) await pool.query("INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;", [userId, crewLeaderId]);
      } else if (currentUser.role === "crew_leader" && userId !== Number(currentUser.id)) {
        await pool.query("INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;", [userId, Number(currentUser.id)]);
      }
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.delete("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
    const userId = Number(req.params.id);
    if (req.user.id === userId) return res.status(400).json({ error: "Cannot delete yourself" });
    try {
      if (!isAdminUser(req.user) && !(new Set(await getManagedUserIds(req.user))).has(userId)) return res.status(403).json({ error: "You cannot delete this user" });
      await pool.query("DELETE FROM users WHERE id = $1;", [userId]);
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}
