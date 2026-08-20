export function registerSystemRoutes(app, {
  buildLookupRecords,
  ensureFileStore,
  pool,
  resolveClDFromLookup,
  useFileStore
}) {
  app.get("/health", async (_req, res) => {
    try {
      if (useFileStore) {
        await ensureFileStore();
        return res.json({ ok: true, mode: "file" });
      }
      await pool.query("SELECT 1;");
      return res.json({ ok: true, mode: "postgis" });
    } catch (error) {
      return res.status(500).json({ ok: false, error: error.message });
    }
  });

  app.get("/api/lookup", async (req, res) => {
    const queryValue = String(req.query.q || "").trim();
    if (!queryValue) return res.status(400).json({ error: "Lookup query is required" });
    const result = await resolveClDFromLookup(queryValue);
    if (!result) return res.status(404).json({ error: "CLD not found" });
    return res.json(result);
  });

  app.get("/api/regions", async (_req, res) => {
    const records = await buildLookupRecords();
    res.json({ regions: records });
  });
}
