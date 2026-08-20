export function registerUserRoutes(app, {
  bcrypt, getManagedUserIds, isAdminUser, normalizeUserRole, requireUserManagementAccess,
  resolveUserIdsFromRefs, userRepository
}) {
  app.get("/api/admin/users", requireUserManagementAccess, async (req, res) => {
    try {
      const currentUser = req.user;
      const managedIds = await getManagedUserIds(currentUser);
      const rows = await userRepository.listUsers();
      const visibleRows = isAdminUser(currentUser) ? rows : rows.filter((row) => managedIds.includes(row.id));
      const users = await Promise.all(visibleRows.map(async (row) => ({
        id: row.id, username: row.username, isAdmin: Boolean(row.is_admin || row.role === "admin"),
        role: normalizeUserRole(row.role || (row.is_admin ? "admin" : "enumerator")), createdAt: row.created_at,
        allowedClds: await userRepository.listDirectAllowedClds(row.id), crewLeaderIds: await userRepository.listCrewLeaderIds(row.id),
        crewLeaders: await userRepository.listCrewLeaderUsers(row.id),
        managedUserIds: row.role === "crew_leader" ? await userRepository.listManagedUserIds(row.id) : []
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
      const userId = await userRepository.create({ username, passwordHash: hash, isAdmin, role: resolvedRole });
      if (isAdminUser(currentUser) && Array.isArray(allowedClds) && resolvedRole !== "admin") {
        await userRepository.replaceDirectAllowedClds(userId, allowedClds);
      }
      const crewLeaderSet = new Set();
      if (!isAdminUser(currentUser)) crewLeaderSet.add(Number(currentUser.id));
      else if (Array.isArray(crewLeaderIds)) for (const crewLeaderId of await resolveUserIdsFromRefs(crewLeaderIds)) crewLeaderSet.add(crewLeaderId);
      for (const crewLeaderId of crewLeaderSet) await userRepository.addCrewLeader(userId, crewLeaderId);
      res.status(201).json({ ok: true, userId });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.put("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
    const userId = Number(req.params.id);
    const { password, isAdmin, role, allowedClds, crewLeaderIds } = req.body;
    try {
      const currentUser = req.user;
      const target = await userRepository.findById(userId);
      if (!target) return res.status(404).json({ error: "User not found" });
      const targetRole = normalizeUserRole(target.role || (target.is_admin ? "admin" : "enumerator"));
      const managedIds = new Set(await getManagedUserIds(currentUser));
      if (!isAdminUser(currentUser) && !managedIds.has(userId)) return res.status(403).json({ error: "You cannot manage this user" });
      if (!isAdminUser(currentUser) && userId !== Number(currentUser.id) && targetRole !== "enumerator") return res.status(403).json({ error: "Crew leaders can only manage enumerators" });
      const nextRole = isAdmin ? "admin" : normalizeUserRole(role || targetRole);
      if (!isAdminUser(currentUser) && nextRole !== targetRole) return res.status(403).json({ error: "Crew leaders cannot change user roles" });
      if (password) await userRepository.updatePassword(userId, await bcrypt.hash(password, 10));
      await userRepository.updateRole(userId, nextRole);
      if (isAdminUser(currentUser)) {
        await userRepository.replaceDirectAllowedClds(userId, Array.isArray(allowedClds) && nextRole !== "admin" ? allowedClds : []);
        await userRepository.replaceCrewLeaderIds(userId, Array.isArray(crewLeaderIds) && nextRole === "enumerator" ? await resolveUserIdsFromRefs(crewLeaderIds) : []);
      } else if (currentUser.role === "crew_leader" && userId !== Number(currentUser.id)) {
        await userRepository.addCrewLeader(userId, currentUser.id);
      }
      res.json({ ok: true });
    } catch (error) { res.status(400).json({ error: error.message }); }
  });

  app.delete("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
    const userId = Number(req.params.id);
    if (req.user.id === userId) return res.status(400).json({ error: "Cannot delete yourself" });
    try {
      if (!isAdminUser(req.user) && !(new Set(await getManagedUserIds(req.user))).has(userId)) return res.status(403).json({ error: "You cannot delete this user" });
      await userRepository.delete(userId);
      res.json({ ok: true });
    } catch (error) { res.status(500).json({ error: error.message }); }
  });
}
