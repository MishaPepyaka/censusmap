export function registerRegionRoutes(app, {
  buildFeatureCollection,
  extractCuCode,
  normalizeClD,
  normalizeDwellingNo,
  normalizeFeatures,
  pool,
  repository,
  requireAuth,
  requireClDAccess,
  summarizeRegion,
  useFileStore
}) {
  const {
    createFeature: createRegionFeature,
    createImageUpload,
    deleteFeature: deleteRegionFeature,
    ensureMediaDirs: ensureRegionMediaDirs,
    exists: regionExists,
    readBundle: readRegionBundle,
    updateFeature: updateRegionFeature
  } = repository;
  app.get("/api/cld/:cld", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    try {
      const bundle = await readRegionBundle(cld);
      return res.json(summarizeRegion(bundle.index, bundle));
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
  });

  app.get("/api/cld/:cld/features", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    try {
      const bundle = await readRegionBundle(cld);
      const revision = Number.isFinite(Number(bundle.index.revision)) ? Number(bundle.index.revision) : 1;
      res.set("etag", `\"${revision}\"`);
      return res.json({ ...buildFeatureCollection([...bundle.cu, ...bundle.blocks, ...bundle.dwellings]), revision });
    } catch (error) {
      return res.status(404).json({ error: error.message });
    }
  });

  app.get("/api/cld/:cld/updates/today", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    if (useFileStore) return res.json({ timezone: "America/Winnipeg", updates: [] });
    try {
      const { rows } = await pool.query(`
        SELECT properties, updated_at
        FROM region_features
        WHERE cld = $1 AND feature_type = 'dwellings'
          AND COALESCE(properties->>'_group', '') <> 'special_locations'
          AND updated_at >= (date_trunc('day', NOW() AT TIME ZONE 'America/Winnipeg') AT TIME ZONE 'America/Winnipeg')
          AND updated_at < ((date_trunc('day', NOW() AT TIME ZONE 'America/Winnipeg') + INTERVAL '1 day') AT TIME ZONE 'America/Winnipeg')
        ORDER BY updated_at, id;
      `, [cld]);
      const updates = rows.map((row) => {
        const properties = row.properties || {};
        const cu = extractCuCode(properties);
        const dwellingNo = normalizeDwellingNo(properties.dwellingNo ?? properties.DWELLING_NO ?? properties.vrNumber ?? properties.VR_NUMBER);
        return { ssid: cu && dwellingNo ? `${cu}${dwellingNo}` : "", newCode: String(properties.status ?? ""), note: String(properties.notes ?? ""), updatedAt: row.updated_at };
      }).filter((update) => Boolean(update.ssid));
      res.set("cache-control", "no-store");
      return res.json({ timezone: "America/Winnipeg", updates });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/cld/:cld/features", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    try {
      const features = normalizeFeatures(req.body);
      if (features.length !== 1) return res.status(400).json({ error: "Send exactly one GeoJSON Feature in request body" });
      const id = await createRegionFeature(cld, features[0]);
      return res.status(201).json({ ok: true, inserted: 1, ids: [id] });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.put("/api/cld/:cld/features/:id", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    const id = Number(req.params.id);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid feature id" });
    try {
      const features = normalizeFeatures(req.body);
      if (features.length !== 1) return res.status(400).json({ error: "Send exactly one GeoJSON Feature in request body" });
      const updated = await updateRegionFeature(cld, id, features[0]);
      if (!updated) return res.status(404).json({ error: "Feature not found" });
      return res.json({ ok: true, updatedId: id });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.delete("/api/cld/:cld/features/:id", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    const id = Number(req.params.id);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    if (!Number.isFinite(id)) return res.status(400).json({ error: "Invalid feature id" });
    try {
      const deleted = await deleteRegionFeature(cld, id);
      if (!deleted) return res.status(404).json({ error: "Feature not found" });
      return res.json({ ok: true, deletedId: id });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });

  app.post("/api/cld/:cld/uploads", requireAuth, requireClDAccess, async (req, res) => {
    const cld = normalizeClD(req.params.cld);
    if (!cld) return res.status(400).json({ error: "Invalid CLD" });
    try {
      if (!(await regionExists(cld))) return res.status(404).json({ error: `Unknown CLD ${cld}` });
      await ensureRegionMediaDirs(cld);
      const upload = await createImageUpload(cld, req.body || {});
      return res.status(201).json({ ok: true, upload });
    } catch (error) {
      return res.status(400).json({ error: error.message });
    }
  });
}
