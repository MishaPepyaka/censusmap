import { extractCuCode, normalizeRegionFeature, uniqueSorted } from "../domain/region-feature.js";

function toRegionIndex(row) {
  return {
    cld: row.cld, label: row.label || `CLD ${row.cld}`,
    ssids: Array.isArray(row.ssids) ? row.ssids : [],
    cuCodes: Array.isArray(row.cu_codes) ? row.cu_codes : [],
    createdAt: row.created_at, updatedAt: row.updated_at
  };
}

export function toRegionFeature(row) {
  return normalizeRegionFeature({ type: "Feature", id: row.id, properties: row.properties || {}, geometry: row.geometry });
}

export function createPostgisRegionRepository(pool) {
  return Object.freeze({
    async exists(cld) {
      const { rows } = await pool.query("SELECT 1 FROM cld_regions WHERE cld = $1 LIMIT 1;", [cld]);
      return rows.length > 0;
    },
    async readIndex(cld) {
      const { rows } = await pool.query("SELECT cld, label, ssids, cu_codes, created_at, updated_at FROM cld_regions WHERE cld = $1 LIMIT 1;", [cld]);
      if (rows.length === 0) throw new Error(`Unknown CLD ${cld}`);
      return toRegionIndex(rows[0]);
    },
    async readFeatures(cld, type) {
      const { rows } = await pool.query("SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry FROM region_features WHERE cld = $1 AND feature_type = $2 ORDER BY id;", [cld, type]);
      return rows.map(toRegionFeature);
    },
    async readBundle(cld) {
      const [index, cu, blocks, dwellings] = await Promise.all([
        this.readIndex(cld), this.readFeatures(cld, "cu"), this.readFeatures(cld, "blocks"), this.readFeatures(cld, "dwellings")
      ]);
      return { index, cu, blocks, dwellings };
    },
    async findFeature(cld, id) {
      const { rows } = await pool.query(
        `
          SELECT id, feature_type, properties, ST_AsGeoJSON(geom)::json AS geometry
          FROM region_features
          WHERE cld = $1 AND id = $2
          LIMIT 1;
        `,
        [cld, Number(id)]
      );
      if (rows.length === 0) return null;
      return { type: rows[0].feature_type, feature: toRegionFeature(rows[0]) };
    },
    async createFeature(cld, type, feature) {
      const normalized = normalizeRegionFeature(feature);
      const { rows } = await pool.query(
        `
          INSERT INTO region_features (cld, feature_type, properties, geom)
          VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
          RETURNING id;
        `,
        [cld, type, JSON.stringify(normalized.properties || {}), JSON.stringify(normalized.geometry)]
      );
      return rows[0].id;
    },
    async updateFeature(cld, id, feature) {
      const normalized = normalizeRegionFeature(feature);
      await pool.query(
        `
          UPDATE region_features
          SET
            properties = $3::jsonb,
            geom = ST_SetSRID(ST_GeomFromGeoJSON($4), 4326),
            updated_at = NOW()
          WHERE id = $1 AND cld = $2;
        `,
        [id, cld, JSON.stringify(normalized.properties || {}), JSON.stringify(normalized.geometry)]
      );
    },
    async deleteFeature(cld, id) {
      await pool.query("DELETE FROM region_features WHERE id = $1 AND cld = $2;", [id, cld]);
    },
    async writeIndex(cld, index) {
      await pool.query(
        `
          UPDATE cld_regions
          SET
            label = $2,
            ssids = $3::text[],
            cu_codes = $4::text[],
            updated_at = NOW()
          WHERE cld = $1;
        `,
        [
          cld,
          index.label || `CLD ${cld}`,
          Array.isArray(index.ssids) ? index.ssids : [],
          Array.isArray(index.cuCodes) ? index.cuCodes : []
        ]
      );
    },
    async writeFeatures(cld, type, features) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("DELETE FROM region_features WHERE cld = $1 AND feature_type = $2;", [cld, type]);
        for (const feature of features) {
          const normalized = normalizeRegionFeature(feature);
          if (!normalized.geometry) continue;
          if (Number.isFinite(Number(normalized.id))) {
            await client.query(
              `
                INSERT INTO region_features (id, cld, feature_type, properties, geom)
                VALUES ($1, $2, $3, $4::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($5), 4326))
                ON CONFLICT (id) DO UPDATE SET
                  cld = EXCLUDED.cld,
                  feature_type = EXCLUDED.feature_type,
                  properties = EXCLUDED.properties,
                  geom = EXCLUDED.geom,
                  updated_at = NOW();
              `,
              [Number(normalized.id), cld, type, JSON.stringify(normalized.properties || {}), JSON.stringify(normalized.geometry)]
            );
          } else {
            await client.query(
              `
                INSERT INTO region_features (cld, feature_type, properties, geom)
                VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326));
              `,
              [cld, type, JSON.stringify(normalized.properties || {}), JSON.stringify(normalized.geometry)]
            );
          }
        }
        if (type === "cu") {
          const cuCodes = uniqueSorted(features.map((feature) => extractCuCode(feature?.properties || {})));
          await client.query(
            "UPDATE cld_regions SET cu_codes = $2::text[], updated_at = NOW() WHERE cld = $1;",
            [cld, cuCodes]
          );
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    }
  });
}
