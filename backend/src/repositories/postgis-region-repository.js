import { normalizeRegionFeature } from "../domain/region-feature.js";

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
    }
  });
}
