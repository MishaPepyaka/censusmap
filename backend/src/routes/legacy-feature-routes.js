export function registerLegacyFeatureRoutes(app, {
  assertDwellingNoUnique, buildFeatureCollection, createRegionFeature, normalizeClD,
  normalizeFeatures, normalizeRegionFeature, pool, readFileStore, useFileStore, writeFileStore
}) {
app.get("/api/features", async (_req, res) => {
  if (useFileStore) {
    const store = await readFileStore();
    const features = store.features.map((row) => ({
      type: "Feature",
      id: row.id,
      properties: {
        ...(row.properties || {}),
        _id: row.id,
        _name: row.name,
        _createdAt: row.createdAt,
        _updatedAt: row.updatedAt
      },
      geometry: row.geometry
    }));
    return res.json(buildFeatureCollection(features));
  }

  const query = `
    SELECT
      id,
      name,
      properties,
      ST_AsGeoJSON(geom)::json AS geometry,
      created_at,
      updated_at
    FROM map_features
    ORDER BY id;
  `;
  const { rows } = await pool.query(query);
  const features = rows.map((row) => ({
    type: "Feature",
    id: row.id,
    properties: {
      ...(row.properties || {}),
      _id: row.id,
      _name: row.name,
      _createdAt: row.created_at,
      _updatedAt: row.updated_at
    },
    geometry: row.geometry
  }));
  return res.json(buildFeatureCollection(features));
});

app.post("/api/features", async (req, res) => {
  try {
    const features = normalizeFeatures(req.body);
    if (features.length === 0) {
      return res.status(400).json({ error: "Send GeoJSON Feature or FeatureCollection in request body" });
    }

    if (useFileStore) {
      const store = await readFileStore();
      const ids = [];
      for (const feature of features) {
        const normalized = normalizeRegionFeature(feature);
        if (!normalized.geometry) throw new Error("Feature geometry is required");
        assertDwellingNoUnique(normalized, store.features);
        const properties = normalized.properties || {};
        const now = new Date().toISOString();
        const id = store.nextId;
        store.nextId += 1;
        store.features.push({
          id,
          name: typeof properties.name === "string" ? properties.name : null,
          properties,
          geometry: normalized.geometry,
          createdAt: now,
          updatedAt: now
        });
        ids.push(id);
      }
      await writeFileStore(store);
      return res.status(201).json({ inserted: ids.length, ids });
    }

    const ids = [];
    for (const feature of features) {
      if (!feature?.geometry) throw new Error("Feature geometry is required");
      const properties = feature.properties && typeof feature.properties === "object" ? feature.properties : {};
      const name = typeof properties.name === "string"
        ? properties.name
        : (typeof properties._name === "string" ? properties._name : null);
      const query = `
        INSERT INTO map_features (name, properties, geom)
        VALUES ($1, $2::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($3), 4326))
        RETURNING id;
      `;
      const values = [name, JSON.stringify(properties), JSON.stringify(feature.geometry)];
      const { rows } = await pool.query(query, values);
      ids.push(rows[0].id);
    }
    return res.status(201).json({ inserted: ids.length, ids });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/import/geojson", async (req, res) => {
  try {
    const features = normalizeFeatures(req.body);
    if (features.length === 0) {
      return res.status(400).json({ ok: false, error: "Body must be GeoJSON Feature or FeatureCollection" });
    }
    const targetClD = normalizeClD(req.query.cld || req.body?.cld || "");
    if (targetClD) {
      const ids = [];
      for (const feature of features) {
        ids.push(await createRegionFeature(targetClD, feature));
      }
      return res.status(201).json({ ok: true, imported: ids.length, ids, cld: targetClD });
    }

    return res.status(400).json({
      ok: false,
      error: "Provide ?cld=<CLD_number> to import into a CLD region file"
    });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error.message });
  }
});

app.delete("/api/features/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid feature id" });
  }
  if (useFileStore) {
    const store = await readFileStore();
    const before = store.features.length;
    store.features = store.features.filter((item) => Number(item.id) !== id);
    if (store.features.length === before) {
      return res.status(404).json({ error: "Feature not found" });
    }
    await writeFileStore(store);
    return res.json({ ok: true, deletedId: id });
  }
  const { rowCount } = await pool.query("DELETE FROM map_features WHERE id = $1;", [id]);
  if (rowCount === 0) {
    return res.status(404).json({ error: "Feature not found" });
  }
  return res.json({ ok: true, deletedId: id });
});

app.put("/api/features/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid feature id" });
  }
  try {
    const features = normalizeFeatures(req.body);
    if (features.length !== 1) {
      return res.status(400).json({ error: "Send exactly one GeoJSON Feature in request body" });
    }
    if (useFileStore) {
      const store = await readFileStore();
      const row = store.features.find((feature) => Number(feature.id) === id);
      if (!row) {
        return res.status(404).json({ error: "Feature not found" });
      }
      assertDwellingNoUnique(features[0], store.features, id);
      row.properties = features[0].properties || {};
      row.geometry = features[0].geometry;
      row.updatedAt = new Date().toISOString();
      await writeFileStore(store);
      return res.json({ ok: true, updatedId: id });
    }

    const properties = features[0].properties && typeof features[0].properties === "object"
      ? features[0].properties
      : {};
    const name = typeof properties.name === "string" ? properties.name : null;
    const query = `
      UPDATE map_features
      SET
        name = $2,
        properties = $3::jsonb,
        geom = ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
        updated_at = NOW()
      WHERE id = $1;
    `;
    const values = [id, name, JSON.stringify(properties), JSON.stringify(features[0].geometry)];
    const { rowCount } = await pool.query(query, values);
    if (rowCount === 0) {
      return res.status(404).json({ error: "Feature not found" });
    }
    return res.json({ ok: true, updatedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/features", async (_req, res) => {
  if (useFileStore) {
    await writeFileStore({ nextId: 1, features: [] });
    return res.json({ ok: true });
  }
  await pool.query("TRUNCATE TABLE map_features RESTART IDENTITY;");
  return res.json({ ok: true });
});

}

