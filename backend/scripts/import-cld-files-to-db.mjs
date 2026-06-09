#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Pool } from "pg";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..", "..");

async function resolveClDRootDir() {
  const candidates = [
    process.env.CLD_ROOT_DIR,
    process.env.DATA_ROOT ? path.join(process.env.DATA_ROOT, "cld") : null,
    path.join(repoRoot, "data", "cld"),
    "/data/cld"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return candidates[0] || path.join(repoRoot, "data", "cld");
}

function buildFeatureCollection(features) {
  return {
    type: "FeatureCollection",
    features: Array.isArray(features) ? features : []
  };
}

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeFeature(feature) {
  return {
    type: "Feature",
    ...(feature?.id !== undefined ? { id: Number(feature.id) } : {}),
    properties: feature?.properties && typeof feature.properties === "object" ? { ...feature.properties } : {},
    geometry: feature?.geometry || null
  };
}

async function initDb(pool) {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS cld_regions (
        cld TEXT PRIMARY KEY,
        label TEXT NOT NULL,
        ssids TEXT[] NOT NULL DEFAULT '{}',
        cu_codes TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS region_features (
        id BIGSERIAL PRIMARY KEY,
        cld TEXT NOT NULL REFERENCES cld_regions(cld) ON DELETE CASCADE,
        feature_type TEXT NOT NULL CHECK (feature_type IN ('cu', 'blocks', 'dwellings')),
        properties JSONB NOT NULL DEFAULT '{}'::jsonb,
        geom geometry(Geometry, 4326) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_region_features_cld_type ON region_features (cld, feature_type);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_region_features_geom ON region_features USING GIST (geom);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_region_features_properties ON region_features USING GIN (properties);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_cld_regions_cu_codes ON cld_regions USING GIN (cu_codes);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_cld_regions_ssids ON cld_regions USING GIN (ssids);");
  } finally {
    client.release();
  }
}

async function listClDDirectories(cldRootDir) {
  if (!(await exists(cldRootDir))) return [];
  const entries = await fs.readdir(cldRootDir, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && /^[0-9]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

async function readRegionFiles(cldRootDir, cld) {
  const regionDir = path.join(cldRootDir, cld);
  const index = await readJsonFile(path.join(regionDir, "index.json"), {
    cld,
    label: `CLD ${cld}`,
    ssids: [],
    cuCodes: []
  });
  const cu = await readJsonFile(path.join(regionDir, "cu.geojson"), buildFeatureCollection([]));
  const blocks = await readJsonFile(path.join(regionDir, "blocks.geojson"), buildFeatureCollection([]));
  const dwellings = await readJsonFile(path.join(regionDir, "dwellings.geojson"), buildFeatureCollection([]));
  return {
    index,
    cu: (cu.features || []).map(normalizeFeature),
    blocks: (blocks.features || []).map(normalizeFeature),
    dwellings: (dwellings.features || []).map(normalizeFeature)
  };
}

async function importClD(pool, cldRootDir, cld) {
  const region = await readRegionFiles(cldRootDir, cld);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `
        INSERT INTO cld_regions (cld, label, ssids, cu_codes)
        VALUES ($1, $2, $3::text[], $4::text[])
        ON CONFLICT (cld) DO UPDATE SET
          label = EXCLUDED.label,
          ssids = EXCLUDED.ssids,
          cu_codes = EXCLUDED.cu_codes,
          updated_at = NOW();
      `,
      [
        cld,
        region.index.label || `CLD ${cld}`,
        Array.isArray(region.index.ssids) ? region.index.ssids : [],
        Array.isArray(region.index.cuCodes) ? region.index.cuCodes : []
      ]
    );
    await client.query("DELETE FROM region_features WHERE cld = $1;", [cld]);

    for (const [featureType, features] of Object.entries({
      cu: region.cu,
      blocks: region.blocks,
      dwellings: region.dwellings
    })) {
      for (const feature of features) {
        if (!feature.geometry) continue;
        if (Number.isFinite(Number(feature.id))) {
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
            [
              Number(feature.id),
              cld,
              featureType,
              JSON.stringify(feature.properties || {}),
              JSON.stringify(feature.geometry)
            ]
          );
        } else {
          await client.query(
            `
              INSERT INTO region_features (cld, feature_type, properties, geom)
              VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326));
            `,
            [cld, featureType, JSON.stringify(feature.properties || {}), JSON.stringify(feature.geometry)]
          );
        }
      }
    }
    await client.query("COMMIT");
    return {
      cld,
      cu: region.cu.length,
      blocks: region.blocks.length,
      dwellings: region.dwellings.length
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function main() {
  const pool = new Pool({
    host: process.env.POSTGRES_HOST || "localhost",
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB || "maps",
    user: process.env.POSTGRES_USER || "maps",
    password: process.env.POSTGRES_PASSWORD || "maps"
  });

  try {
    await initDb(pool);
    const cldRootDir = await resolveClDRootDir();
    const clds = await listClDDirectories(cldRootDir);
    if (clds.length === 0) {
      throw new Error(`No CLD directories found in ${cldRootDir}`);
    }

    let totalCu = 0;
    let totalBlocks = 0;
    let totalDwellings = 0;

    for (const cld of clds) {
      const summary = await importClD(pool, cldRootDir, cld);
      totalCu += summary.cu;
      totalBlocks += summary.blocks;
      totalDwellings += summary.dwellings;
      console.log(`Imported CLD ${summary.cld}: CU=${summary.cu}, blocks=${summary.blocks}, dwellings=${summary.dwellings}`);
    }

    await pool.query(
      `
        SELECT setval(
          pg_get_serial_sequence('region_features', 'id'),
          COALESCE((SELECT MAX(id) FROM region_features), 1),
          true
        );
      `
    );

    console.log(
      JSON.stringify(
        {
          importedClDs: clds.length,
          cu: totalCu,
          blocks: totalBlocks,
          dwellings: totalDwellings
        },
        null,
        2
      )
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
