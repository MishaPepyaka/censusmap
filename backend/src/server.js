import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { Pool } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import cookieParser from "cookie-parser";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..", "..");
const publicDir = path.join(__dirname, "..", "public");
const dataDir = path.join(repoRoot, "data");
const cldRootDir = path.join(dataDir, "cld");

const app = express();
const port = Number(process.env.PORT || 8080);
const useFileStore = String(process.env.USE_FILE_STORE || "false").toLowerCase() === "true";
const fileStorePath = process.env.FILE_STORE_PATH || path.join(dataDir, "file-store.json");
const jwtSecret = process.env.JWT_SECRET || "census-map-secret-key-2026";

const pool = useFileStore
  ? null
  : new Pool({
      host: process.env.POSTGRES_HOST || "localhost",
      port: Number(process.env.POSTGRES_PORT || 5432),
      database: process.env.POSTGRES_DB || "maps",
      user: process.env.POSTGRES_USER || "maps",
      password: process.env.POSTGRES_PASSWORD || "maps"
    });

const mapConfig = {
  baseTileUrl: process.env.BASE_TILE_URL || "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  baseTileAttribution: process.env.BASE_TILE_ATTRIBUTION || "&copy; OpenStreetMap contributors",
  cmp: {
    mode: process.env.CMP_MODE || "wms",
    wms: {
      url: process.env.CMP_WMS_URL || "",
      layers: process.env.CMP_WMS_LAYERS || "",
      format: process.env.CMP_WMS_FORMAT || "image/png",
      version: process.env.CMP_WMS_VERSION || "1.1.1",
      attribution: process.env.CMP_WMS_ATTRIBUTION || "Source: Statistics Canada"
    },
    xyz: {
      url: process.env.CMP_XYZ_URL || "",
      attribution: process.env.CMP_XYZ_ATTRIBUTION || "Source: Statistics Canada"
    },
    arcgis: {
      url: process.env.CMP_ARCGIS_URL || "",
      attribution: process.env.CMP_ARCGIS_ATTRIBUTION || "Source: Statistics Canada",
      layers: process.env.CMP_ARCGIS_LAYERS || "",
      useLocalProxy: String(process.env.CMP_ARCGIS_USE_LOCAL_PROXY || "true").toLowerCase() === "true"
    }
  }
};

app.use(helmet({ contentSecurityPolicy: false }));
app.use(morgan("combined"));
app.use(express.json({ limit: "25mb" }));
app.use(cookieParser());
app.use("/vendor/leaflet", express.static(path.join(__dirname, "..", "node_modules", "leaflet", "dist")));
app.use("/vendor/leaflet-draw", express.static(path.join(__dirname, "..", "node_modules", "leaflet-draw", "dist")));
app.use("/vendor/esri-leaflet", express.static(path.join(__dirname, "..", "node_modules", "esri-leaflet", "dist")));
app.use("/media/cld", express.static(cldRootDir));

const AUTH_COOKIE = "census_session";
const USER_ROLES = new Set(["admin", "crew_leader", "enumerator"]);

function hasText(value) {
  return value !== undefined && value !== null && String(value).trim().length > 0;
}

function normalizeClD(value) {
  const digits = String(value || "").replace(/\D/g, "");
  return digits || "";
}

function normalizeSsid(value) {
  return String(value || "").trim().toUpperCase();
}

function normalizeDwellingNo(value) {
  if (!hasText(value)) return null;
  const digits = String(value).replace(/\D/g, "");
  if (!digits) return null;
  return digits.padStart(4, "0").slice(-4);
}

function buildFeatureCollection(features) {
  return {
    type: "FeatureCollection",
    features: Array.isArray(features) ? features : []
  };
}

function uniqueSorted(values) {
  return [...new Set((Array.isArray(values) ? values : []).map((value) => String(value || "").trim()).filter(Boolean))].sort();
}

function featureFileNames() {
  return {
    cu: "cu.geojson",
    blocks: "blocks.geojson",
    dwellings: "dwellings.geojson"
  };
}

function extractClDFromProperties(properties) {
  if (!properties || typeof properties !== "object") return "";
  const direct = normalizeClD(properties.cld || properties.CLD || properties.CFOP_CLD_ID);
  if (direct) return direct;
  const zone = normalizeClD(properties.zone || properties.CFOP_ZONE_ID);
  if (zone) return zone.slice(0, 4);
  return "";
}

function extractCuCode(properties) {
  if (!properties || typeof properties !== "object") return "";
  const direct = String(properties.CUID || properties.cu || "").trim();
  if (direct) return direct;
  const fromName = String(properties.name || properties.label || "").split("/")[0].trim();
  return fromName;
}

function isPointGeometry(geometry) {
  return geometry?.type === "Point";
}

function isPolygonGeometry(geometry) {
  return geometry?.type === "Polygon" || geometry?.type === "MultiPolygon";
}

function hasDwellingIdentifier(properties) {
  return Boolean(
    normalizeDwellingNo(properties?.dwellingNo ?? properties?.DWELLING_NO ?? properties?.vrNumber ?? properties?.VR_NUMBER)
  );
}

function normalizeRegionFeature(feature) {
  const normalized = feature && typeof feature === "object" ? { ...feature } : {};
  normalized.type = "Feature";
  normalized.properties = normalized.properties && typeof normalized.properties === "object" ? { ...normalized.properties } : {};
  normalized.geometry = normalized.geometry && typeof normalized.geometry === "object" ? { ...normalized.geometry } : null;
  if (normalized.id !== undefined && normalized.id !== null && normalized.id !== "") {
    const numericId = Number(normalized.id);
    normalized.id = Number.isFinite(numericId) ? numericId : normalized.id;
  }
  return normalized;
}

function classifyFeature(feature) {
  const normalized = normalizeRegionFeature(feature);
  const properties = normalized.properties || {};
  const geometry = normalized.geometry || {};
  const group = String(properties._group || "").trim().toLowerCase();
  if (isPointGeometry(geometry)) {
    if (group === "dwellings" || group === "dwelling" || hasDwellingIdentifier(properties)) {
      return "dwellings";
    }
    return "dwellings";
  }
  if (!isPolygonGeometry(geometry)) return "";
  if (group === "cu" || group === "cus") return "cu";
  if (group === "blocks" || group === "block") return "blocks";
  if (hasText(properties.COLB_UID) || hasText(properties.CB_COLCODE) || hasText(properties.block) || hasText(properties.GEOCODE)) {
    return "blocks";
  }
  if (hasText(properties.CUID) || hasText(properties.cu) || hasText(properties.CU_TYPE)) {
    return "cu";
  }
  return "";
}

function normalizeFeatures(payload) {
  if (Array.isArray(payload)) {
    return payload.map((feature) => normalizeRegionFeature(feature));
  }
  if (payload && typeof payload === "object") {
    if (Array.isArray(payload.features)) {
      return payload.features.map((feature) => normalizeRegionFeature(feature));
    }
    if (payload.type === "Feature") {
      return [normalizeRegionFeature(payload)];
    }
  }
  return [];
}

function normalizeUserRole(value) {
  const role = String(value || "").trim().toLowerCase();
  if (USER_ROLES.has(role)) return role;
  return "enumerator";
}

function isAdminUser(user) {
  return Boolean(user?.isAdmin || user?.role === "admin");
}

async function loadUserById(userId) {
  if (!Number.isFinite(Number(userId))) return null;
  const { rows } = await pool.query(
    `
      SELECT id, username, password_hash, is_admin, role, created_at
      FROM users
      WHERE id = $1
      LIMIT 1;
    `,
    [Number(userId)]
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  const allowedClds = await getDirectAllowedClds(row.id);
  const crewLeaderIds = await getCrewLeaderIdsForUser(row.id);
  return {
    id: row.id,
    username: row.username,
    isAdmin: Boolean(row.is_admin || row.role === "admin"),
    role: normalizeUserRole(row.role || (row.is_admin ? "admin" : "enumerator")),
    createdAt: row.created_at,
    allowedClds,
    crewLeaderIds
  };
}

function getSessionUser(req) {
  const token = req.cookies?.[AUTH_COOKIE];
  if (!token) return null;
  try {
    const user = jwt.verify(token, jwtSecret);
    return user;
  } catch (err) {
    console.error("JWT verification failed:", err.message);
    return null;
  }
}

async function getUser(req) {
  const session = getSessionUser(req);
  if (!session?.id) return null;
  const user = await loadUserById(session.id);
  if (!user) return null;
  return user;
}

async function requireAuth(req, res, next) {
  const user = await getUser(req);
  if (!user) {
    console.log(`Auth required for ${req.path}`);
    if (req.xhr || req.headers.accept?.includes("application/json") || req.path.startsWith("/api/")) {
      return res.status(401).json({ error: "Authentication required" });
    }
    return res.redirect("/login");
  }
  req.user = user;
  next();
}

async function requireAdmin(req, res, next) {
  const user = await getUser(req);
  if (!user || !isAdminUser(user)) {
    console.log(`Admin access denied for ${user?.username || "anonymous"} at ${req.path}`);
    if (req.xhr || req.headers.accept?.includes("application/json") || req.path.startsWith("/api/")) {
      return res.status(403).json({ error: "Admin access required" });
    }
    return res.redirect("/");
  }
  req.user = user;
  next();
}

async function requireUserManagementAccess(req, res, next) {
  const user = await getUser(req);
  if (!user || !(isAdminUser(user) || user.role === "crew_leader")) {
    return res.status(403).json({ error: "User management access required" });
  }
  req.user = user;
  next();
}

async function getDirectAllowedClds(userId) {
  const { rows } = await pool.query(
    "SELECT cld FROM user_clds WHERE user_id = $1 ORDER BY cld;",
    [Number(userId)]
  );
  return rows.map((row) => row.cld);
}

async function getCrewLeaderIdsForUser(userId) {
  const { rows } = await pool.query(
    "SELECT crew_leader_id FROM user_crew_leaders WHERE user_id = $1 ORDER BY crew_leader_id;",
    [Number(userId)]
  );
  return rows.map((row) => row.crew_leader_id);
}

async function getCrewLeaderUsersForUser(userId) {
  const { rows } = await pool.query(
    `
      SELECT u.id, u.username
      FROM user_crew_leaders ucl
      JOIN users u ON u.id = ucl.crew_leader_id
      WHERE ucl.user_id = $1
      ORDER BY u.username;
    `,
    [Number(userId)]
  );
  return rows;
}

async function resolveUserIdsFromRefs(values) {
  const refs = Array.isArray(values)
    ? values
    : String(values || "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
  const ids = new Set();
  for (const ref of refs) {
    const maybeId = Number(ref);
    if (Number.isFinite(maybeId)) {
      ids.add(maybeId);
      continue;
    }
    const { rows } = await pool.query("SELECT id FROM users WHERE username = $1 LIMIT 1;", [ref]);
    if (rows.length > 0) {
      ids.add(rows[0].id);
    }
  }
  return [...ids];
}

async function getManagedUsersForCrewLeader(userId) {
  const { rows } = await pool.query(
    `
      SELECT DISTINCT u.id
      FROM user_crew_leaders ucl
      JOIN users u ON u.id = ucl.user_id
      WHERE ucl.crew_leader_id = $1
      ORDER BY u.id;
    `,
    [Number(userId)]
  );
  return rows.map((row) => row.id);
}

async function getManagedUserIds(user) {
  if (!user) return [];
  if (isAdminUser(user)) {
    const { rows } = await pool.query("SELECT id FROM users ORDER BY id;");
    return rows.map((row) => row.id);
  }
  if (user.role === "crew_leader") {
    const { rows } = await pool.query(
      `
        SELECT DISTINCT user_id AS id
        FROM user_crew_leaders
        WHERE crew_leader_id = $1
        UNION
        SELECT $1::integer AS id
        ORDER BY id;
      `,
      [Number(user.id)]
    );
    return rows.map((row) => row.id);
  }
  return [Number(user.id)];
}

async function hasClDAccess(user, cld) {
  if (!user) return false;
  if (isAdminUser(user)) return true;
  const { rows } = await pool.query(
    `
      SELECT 1
      FROM (
        SELECT cld FROM user_clds WHERE user_id = $1
        UNION
        SELECT ucl.cld
        FROM user_crew_leaders rel
        JOIN user_clds ucl ON ucl.user_id = rel.crew_leader_id
        WHERE rel.user_id = $1
      ) allowed
      WHERE cld = $2
      LIMIT 1;
    `,
    [user.id, cld]
  );
  return rows.length > 0;
}

async function requireClDAccess(req, res, next) {
  const cld = normalizeClD(req.params.cld || req.query.cld || "");
  if (!cld) return next();
  const allowed = await hasClDAccess(req.user, cld);
  if (!allowed) {
    return res.status(403).json({ error: `Access to CLD ${cld} denied` });
  }
  next();
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username TEXT UNIQUE NOT NULL,
        password_hash TEXT NOT NULL,
        is_admin BOOLEAN NOT NULL DEFAULT FALSE,
        role TEXT NOT NULL DEFAULT 'enumerator',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'enumerator';
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_clds (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        cld TEXT NOT NULL,
        PRIMARY KEY (user_id, cld)
      );
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS user_crew_leaders (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        crew_leader_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        PRIMARY KEY (user_id, crew_leader_id)
      );
    `);
    await client.query("CREATE INDEX IF NOT EXISTS idx_user_crew_leaders_crew_leader_id ON user_crew_leaders (crew_leader_id);");
    await client.query("CREATE INDEX IF NOT EXISTS idx_user_crew_leaders_user_id ON user_crew_leaders (user_id);");
    await client.query("UPDATE users SET role = 'admin' WHERE is_admin = TRUE;");
    await client.query("UPDATE users SET role = 'enumerator' WHERE is_admin = FALSE AND (role IS NULL OR role = '');");
    await client.query("UPDATE users SET role = CASE WHEN is_admin THEN 'admin' ELSE role END;");
    
    // Create admin user if it doesn't exist
    const { rows } = await client.query("SELECT 1 FROM users WHERE username = 'misha' LIMIT 1;");
    if (rows.length === 0) {
      const hash = await bcrypt.hash("pepka", 10);
      await client.query(
        "INSERT INTO users (username, password_hash, is_admin, role) VALUES ('misha', $1, TRUE, 'admin');",
        [hash]
      );
      console.log("Admin user 'misha' created.");
    }

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
    await client.query(`
      CREATE TABLE IF NOT EXISTS map_features (
        id BIGSERIAL PRIMARY KEY,
        name TEXT,
        properties JSONB NOT NULL DEFAULT '{}'::jsonb,
        geom geometry(Geometry, 4326) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
  } finally {
    client.release();
  }
}

async function regionExists(cld) {
  if (useFileStore) {
    return exists(path.join(cldRootDir, cld, "index.json"));
  }
  const { rows } = await pool.query("SELECT 1 FROM cld_regions WHERE cld = $1 LIMIT 1;", [cld]);
  return rows.length > 0;
}

async function ensureRegionMediaDirs(cld) {
  const regionDir = path.join(cldRootDir, cld);
  await ensureDir(path.join(regionDir, "media", "dwellings"));
  await ensureDir(path.join(regionDir, "media", "uploads"));
}

function regionRowToIndex(row) {
  return {
    cld: row.cld,
    label: row.label || `CLD ${row.cld}`,
    ssids: Array.isArray(row.ssids) ? row.ssids : [],
    cuCodes: Array.isArray(row.cu_codes) ? row.cu_codes : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function regionFeatureRowToFeature(row) {
  return {
    type: "Feature",
    id: row.id,
    properties: row.properties || {},
    geometry: row.geometry
  };
}

async function ensureRegionRecord(cld, label = `CLD ${cld}`) {
  await pool.query(
    `
      INSERT INTO cld_regions (cld, label)
      VALUES ($1, $2)
      ON CONFLICT (cld) DO NOTHING;
    `,
    [cld, label]
  );
}

async function syncRegionCuCodes(cld) {
  const { rows } = await pool.query(
    `
      SELECT DISTINCT COALESCE(properties->>'CUID', properties->>'cu') AS cu_code
      FROM region_features
      WHERE cld = $1 AND feature_type = 'cu'
      ORDER BY cu_code;
    `,
    [cld]
  );
  const cuCodes = rows.map((row) => String(row.cu_code || "").trim()).filter(Boolean);
  await pool.query(
    `
      UPDATE cld_regions
      SET cu_codes = $2::text[], updated_at = NOW()
      WHERE cld = $1;
    `,
    [cld, cuCodes]
  );
}

async function ensureFileStore() {
  if (!useFileStore) return;
  if (await exists(fileStorePath)) return;
  await writeJsonFile(fileStorePath, { nextId: 1, features: [] });
}

async function readFileStore() {
  await ensureFileStore();
  const parsed = await readJsonFile(fileStorePath, { nextId: 1, features: [] });
  if (!Number.isFinite(parsed?.nextId) || !Array.isArray(parsed?.features)) {
    return { nextId: 1, features: [] };
  }
  return parsed;
}

async function writeFileStore(store) {
  await writeJsonFile(fileStorePath, store);
}

async function readLegacyFeatures() {
  const sources = [
    path.join(dataDir, "file-store.json"),
    path.join(publicDir, "file-store.json"),
    path.join(publicDir, "features.geojson")
  ];

  for (const source of sources) {
    if (!(await exists(source))) continue;
    const parsed = await readJsonFile(source, null);
    if (!parsed) continue;
    if (Array.isArray(parsed.features)) {
      return parsed.features.map((feature) => normalizeRegionFeature(feature));
    }
    if (Array.isArray(parsed)) {
      return parsed.map((feature) => normalizeRegionFeature(feature));
    }
  }
  return [];
}

function buildCuToClDMap(features) {
  const map = new Map();
  for (const feature of features) {
    const properties = feature?.properties || {};
    const cuCode = extractCuCode(properties);
    const cld = extractClDFromProperties(properties);
    if (hasText(cuCode) && hasText(cld)) {
      map.set(cuCode, cld);
    }
  }
  return map;
}

function extractClDForFeature(feature, cuToClDMap) {
  const properties = feature?.properties || {};
  const direct = extractClDFromProperties(properties);
  if (direct) return direct;
  const cuCode = extractCuCode(properties);
  if (cuCode && cuToClDMap.has(cuCode)) {
    return cuToClDMap.get(cuCode);
  }
  return "";
}

async function ensureEmptyRegionFiles(cld) {
  if (!useFileStore) {
    if (!(await regionExists(cld))) {
      throw new Error(`Unknown CLD ${cld}`);
    }
    await ensureRegionMediaDirs(cld);
    return;
  }
  const regionDir = path.join(cldRootDir, cld);
  const names = featureFileNames();
  await ensureRegionMediaDirs(cld);
  const initialFiles = [
    path.join(regionDir, names.cu),
    path.join(regionDir, names.blocks),
    path.join(regionDir, names.dwellings)
  ];
  for (const filePath of initialFiles) {
    if (!(await exists(filePath))) {
      await writeJsonFile(filePath, buildFeatureCollection([]));
    }
  }
  const indexPath = path.join(regionDir, "index.json");
  if (!(await exists(indexPath))) {
    await writeJsonFile(indexPath, {
      cld,
      label: `CLD ${cld}`,
      ssids: [],
      cuCodes: [],
      nextFeatureId: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
}

async function migrateLegacyDataToClDStore() {
  await ensureDir(cldRootDir);
  const existingEntries = await fs.readdir(cldRootDir, { withFileTypes: true }).catch(() => []);
  if (existingEntries.some((entry) => entry.isDirectory())) {
    return;
  }

  const legacyFeatures = await readLegacyFeatures();
  if (legacyFeatures.length === 0) {
    return;
  }

  const cuToClDMap = buildCuToClDMap(legacyFeatures);
  const grouped = new Map();

  for (const feature of legacyFeatures) {
    const cld = extractClDForFeature(feature, cuToClDMap);
    if (!cld) continue;
    if (!grouped.has(cld)) {
      grouped.set(cld, { cu: [], blocks: [], dwellings: [], maxId: 0, cuCodes: new Set() });
    }
    const bucket = grouped.get(cld);
    const normalized = normalizeRegionFeature(feature);
    const featureType = classifyFeature(normalized);
    const featureId = Number(normalized.id);
    if (Number.isFinite(featureId)) {
      bucket.maxId = Math.max(bucket.maxId, featureId);
    }
    const cuCode = extractCuCode(normalized.properties || {});
    if (cuCode) bucket.cuCodes.add(cuCode);
    if (featureType === "cu") bucket.cu.push(normalized);
    else if (featureType === "blocks") bucket.blocks.push(normalized);
    else if (featureType === "dwellings") bucket.dwellings.push(normalized);
  }

  for (const [cld, bucket] of grouped.entries()) {
    const regionDir = path.join(cldRootDir, cld);
    await ensureDir(path.join(regionDir, "media", "dwellings"));
    await ensureDir(path.join(regionDir, "media", "uploads"));
    await writeJsonFile(path.join(regionDir, "index.json"), {
      cld,
      label: `CLD ${cld}`,
      ssids: [],
      cuCodes: [...bucket.cuCodes].sort(),
      nextFeatureId: bucket.maxId + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await writeJsonFile(path.join(regionDir, "cu.geojson"), buildFeatureCollection(bucket.cu));
    await writeJsonFile(path.join(regionDir, "blocks.geojson"), buildFeatureCollection(bucket.blocks));
    await writeJsonFile(path.join(regionDir, "dwellings.geojson"), buildFeatureCollection(bucket.dwellings));
  }
}

async function listClDNumbers() {
  if (!useFileStore) {
    const { rows } = await pool.query("SELECT cld FROM cld_regions ORDER BY cld;");
    return rows.map((row) => row.cld);
  }
  await ensureDir(cldRootDir);
  const entries = await fs.readdir(cldRootDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[0-9]+$/.test(name))
    .sort();
}

async function readRegionIndex(cld) {
  if (!useFileStore) {
    const { rows } = await pool.query(
      `
        SELECT cld, label, ssids, cu_codes, created_at, updated_at
        FROM cld_regions
        WHERE cld = $1
        LIMIT 1;
      `,
      [cld]
    );
    if (rows.length === 0) {
      throw new Error(`Unknown CLD ${cld}`);
    }
    return regionRowToIndex(rows[0]);
  }
  const regionDir = path.join(cldRootDir, cld);
  const index = await readJsonFile(path.join(regionDir, "index.json"), null);
  if (!index) {
    throw new Error(`Unknown CLD ${cld}`);
  }
  return index;
}

async function writeRegionIndex(cld, index) {
  if (!useFileStore) {
    await ensureRegionRecord(cld, index.label || `CLD ${cld}`);
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
    return;
  }
  const regionDir = path.join(cldRootDir, cld);
  await writeJsonFile(path.join(regionDir, "index.json"), {
    ...index,
    cld,
    updatedAt: new Date().toISOString()
  });
}

async function readRegionFeatures(cld, type) {
  if (!useFileStore) {
    const dbType = type;
    const { rows } = await pool.query(
      `
        SELECT id, properties, ST_AsGeoJSON(geom)::json AS geometry
        FROM region_features
        WHERE cld = $1 AND feature_type = $2
        ORDER BY id;
      `,
      [cld, dbType]
    );
    return rows.map((row) => normalizeRegionFeature(regionFeatureRowToFeature(row)));
  }
  const names = featureFileNames();
  const fileName = names[type];
  if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
  const filePath = path.join(cldRootDir, cld, fileName);
  const parsed = await readJsonFile(filePath, buildFeatureCollection([]));
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  return features.map((feature) => normalizeRegionFeature(feature));
}

async function writeRegionFeatures(cld, type, features) {
  if (!useFileStore) {
    const dbType = type;
    await ensureRegionRecord(cld);
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM region_features WHERE cld = $1 AND feature_type = $2;", [cld, dbType]);
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
            [
              Number(normalized.id),
              cld,
              dbType,
              JSON.stringify(normalized.properties || {}),
              JSON.stringify(normalized.geometry)
            ]
          );
        } else {
          await client.query(
            `
              INSERT INTO region_features (cld, feature_type, properties, geom)
              VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326));
            `,
            [cld, dbType, JSON.stringify(normalized.properties || {}), JSON.stringify(normalized.geometry)]
          );
        }
      }
      if (dbType === "cu") {
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
    return;
  }
  const names = featureFileNames();
  const fileName = names[type];
  if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
  const filePath = path.join(cldRootDir, cld, fileName);
  await writeJsonFile(filePath, buildFeatureCollection(features.map((feature) => normalizeRegionFeature(feature))));
}

async function readRegionBundle(cld) {
  if (useFileStore) {
    await ensureEmptyRegionFiles(cld);
  }
  const [index, cu, blocks, dwellings] = await Promise.all([
    readRegionIndex(cld),
    readRegionFeatures(cld, "cu"),
    readRegionFeatures(cld, "blocks"),
    readRegionFeatures(cld, "dwellings")
  ]);
  return { index, cu, blocks, dwellings };
}

function extractDwellingIdentity(properties) {
  if (!properties || typeof properties !== "object") return null;
  const dwellingNo = normalizeDwellingNo(
    properties.dwellingNo ?? properties.DWELLING_NO ?? properties.vrNumber ?? properties.VR_NUMBER
  );
  const cuCode = extractCuCode(properties);
  const rawGroup = hasText(properties._group) ? String(properties._group).trim().toLowerCase() : "";
  const looksLikeDwelling = rawGroup === "dwellings" || hasText(dwellingNo);
  if (!looksLikeDwelling || !cuCode || !dwellingNo) return null;
  return { cuCode, dwellingNo };
}

function buildDwellingDuplicateError(cuCode, dwellingNo, conflictingId) {
  const suffix = Number.isFinite(conflictingId) ? ` (feature id ${conflictingId})` : "";
  return new Error(`Dwelling ${dwellingNo} already exists in CU ${cuCode}${suffix}`);
}

async function assertDwellingNoUnique(feature, dwellings, excludeId = null) {
  const identity = extractDwellingIdentity(feature?.properties || {});
  if (!identity) return;
  const { cuCode, dwellingNo } = identity;
  const conflict = dwellings.find((item) => {
    const itemId = Number(item?.id);
    if (Number.isFinite(excludeId) && itemId === Number(excludeId)) return false;
    const itemIdentity = extractDwellingIdentity(item?.properties || {});
    if (!itemIdentity) return false;
    return itemIdentity.cuCode === cuCode && itemIdentity.dwellingNo === dwellingNo;
  });
  if (conflict) {
    throw buildDwellingDuplicateError(cuCode, dwellingNo, Number(conflict.id));
  }
}

function summarizeRegion(index, bundle) {
  return {
    cld: index.cld,
    label: index.label || `CLD ${index.cld}`,
    ssids: Array.isArray(index.ssids) ? index.ssids : [],
    cuCodes: Array.isArray(index.cuCodes) ? index.cuCodes : [],
    counts: {
      cu: bundle.cu.length,
      blocks: bundle.blocks.length,
      dwellings: bundle.dwellings.length
    }
  };
}

function inferFileTypeFromFeature(feature) {
  const featureType = classifyFeature(feature);
  if (featureType === "cu" || featureType === "blocks" || featureType === "dwellings") {
    return featureType;
  }
  throw new Error("Unsupported feature type");
}

async function findRegionFeatureById(cld, id) {
  if (!useFileStore) {
    const { rows } = await pool.query(
      `
        SELECT id, feature_type, properties, ST_AsGeoJSON(geom)::json AS geometry
        FROM region_features
        WHERE cld = $1 AND id = $2
        LIMIT 1;
      `,
      [cld, Number(id)]
    );
    if (rows.length === 0) {
      return { type: null, feature: null, bundle: null };
    }
    return {
      type: rows[0].feature_type,
      feature: normalizeRegionFeature(regionFeatureRowToFeature(rows[0])),
      bundle: null
    };
  }
  const bundle = await readRegionBundle(cld);
  for (const type of ["cu", "blocks", "dwellings"]) {
    const collection = bundle[type];
    const feature = collection.find((item) => Number(item?.id) === Number(id));
    if (feature) {
      return { type, feature, bundle };
    }
  }
  return { type: null, feature: null, bundle };
}

async function createRegionFeature(cld, feature) {
  const normalized = normalizeRegionFeature(feature);
  if (!normalized.geometry) {
    throw new Error("Feature geometry is required");
  }

  if (!(await regionExists(cld))) {
    throw new Error(`Unknown CLD ${cld}`);
  }

  const type = inferFileTypeFromFeature(normalized);
  const collection = await readRegionFeatures(cld, type);
  const dwellings = type === "dwellings" ? collection : await readRegionFeatures(cld, "dwellings");
  await assertDwellingNoUnique(normalized, dwellings);

  if (!useFileStore) {
    const properties = normalized.properties || {};
    const query = `
      INSERT INTO region_features (cld, feature_type, properties, geom)
      VALUES ($1, $2, $3::jsonb, ST_SetSRID(ST_GeomFromGeoJSON($4), 4326))
      RETURNING id;
    `;
    const values = [cld, type, JSON.stringify(properties), JSON.stringify(normalized.geometry)];
    const { rows } = await pool.query(query, values);
    if (type === "cu") {
      await syncRegionCuCodes(cld);
    }
    return rows[0].id;
  }

  const index = await readRegionIndex(cld);
  const nextId = Number.isFinite(Number(index.nextFeatureId)) ? Number(index.nextFeatureId) : 1;
  normalized.id = nextId;
  collection.push(normalized);
  await writeRegionFeatures(cld, type, collection);

  if (type !== "dwellings") {
    const cuCodes = new Set(Array.isArray(index.cuCodes) ? index.cuCodes : []);
    const cuCode = extractCuCode(normalized.properties || {});
    if (cuCode) cuCodes.add(cuCode);
    index.cuCodes = [...cuCodes].sort();
  }
  index.nextFeatureId = nextId + 1;
  await writeRegionIndex(cld, index);
  return nextId;
}

async function updateRegionFeature(cld, id, feature) {
  if (!Number.isFinite(Number(id))) throw new Error("Invalid feature id");
  const normalized = normalizeRegionFeature(feature);
  if (!normalized.geometry) throw new Error("Feature geometry is required");

  const existing = await findRegionFeatureById(cld, id);
  if (!existing.type) return false;

  const collection = await readRegionFeatures(cld, existing.type);
  const targetIndex = collection.findIndex((item) => Number(item?.id) === Number(id));
  if (targetIndex === -1) return false;

  normalized.id = Number(id);
  const candidateType = inferFileTypeFromFeature(normalized);
  if (candidateType !== existing.type) {
    throw new Error("Changing feature type is not supported");
  }

  const dwellings = existing.type === "dwellings" ? collection : await readRegionFeatures(cld, "dwellings");
  await assertDwellingNoUnique(normalized, dwellings, Number(id));
  if (!useFileStore) {
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
    if (existing.type === "cu") {
      await syncRegionCuCodes(cld);
    }
    return true;
  }
  collection[targetIndex] = normalized;
  await writeRegionFeatures(cld, existing.type, collection);
  return true;
}

async function deleteRegionFeature(cld, id) {
  if (!Number.isFinite(Number(id))) throw new Error("Invalid feature id");
  const existing = await findRegionFeatureById(cld, id);
  if (!existing.type) return false;
  const collection = await readRegionFeatures(cld, existing.type);
  const next = collection.filter((item) => Number(item?.id) !== Number(id));
  if (next.length === collection.length) return false;
  if (!useFileStore) {
    await pool.query("DELETE FROM region_features WHERE id = $1 AND cld = $2;", [id, cld]);
    if (existing.type === "cu") {
      await syncRegionCuCodes(cld);
    }
    return true;
  }
  await writeRegionFeatures(cld, existing.type, next);
  return true;
}

async function buildLookupRecords() {
  if (!useFileStore) {
    const { rows } = await pool.query(
      "SELECT cld, label, ssids, cu_codes, created_at, updated_at FROM cld_regions ORDER BY cld;"
    );
    return rows.map((row) => ({
      cld: row.cld,
      label: row.label || `CLD ${row.cld}`,
      ssids: Array.isArray(row.ssids) ? row.ssids : [],
      cuCodes: Array.isArray(row.cu_codes) ? row.cu_codes : []
    }));
  }
  const clds = await listClDNumbers();
  const records = [];
  for (const cld of clds) {
    const index = await readJsonFile(path.join(cldRootDir, cld, "index.json"), null);
    if (!index) continue;
    records.push({
      cld,
      label: index.label || `CLD ${cld}`,
      ssids: Array.isArray(index.ssids) ? index.ssids : [],
      cuCodes: Array.isArray(index.cuCodes) ? index.cuCodes : []
    });
  }
  return records;
}

async function resolveClDFromLookup(queryValue) {
  const normalizedDigits = normalizeClD(queryValue);
  const normalizedText = normalizeSsid(queryValue);

  if (!useFileStore) {
    if (normalizedDigits) {
      const { rows: directRows } = await pool.query(
        "SELECT cld, label FROM cld_regions WHERE cld = $1 LIMIT 1;",
        [normalizedDigits]
      );
      if (directRows.length > 0) {
        return { cld: directRows[0].cld, matchedBy: "cld", label: directRows[0].label };
      }

      const { rows: cuRows } = await pool.query(
        "SELECT cld, label FROM cld_regions WHERE $1 = ANY(cu_codes) LIMIT 1;",
        [normalizedDigits]
      );
      if (cuRows.length > 0) {
        return { cld: cuRows[0].cld, matchedBy: "cu", label: cuRows[0].label };
      }
    }

    if (normalizedText) {
      const { rows: ssidRows } = await pool.query(
        `
          SELECT cld, label
          FROM cld_regions
          WHERE EXISTS (
            SELECT 1
            FROM unnest(ssids) AS ssid
            WHERE UPPER(BTRIM(ssid)) = $1
          )
          LIMIT 1;
        `,
        [normalizedText]
      );
      if (ssidRows.length > 0) {
        return { cld: ssidRows[0].cld, matchedBy: "ssid", label: ssidRows[0].label };
      }
    }
    return null;
  }

  const records = await buildLookupRecords();

  const directClD = records.find((record) => record.cld === normalizedDigits);
  if (directClD) {
    return { cld: directClD.cld, matchedBy: "cld", label: directClD.label };
  }

  const byCu = records.find((record) => record.cuCodes.includes(normalizedDigits));
  if (byCu) {
    return { cld: byCu.cld, matchedBy: "cu", label: byCu.label };
  }

  const bySsid = records.find((record) =>
    record.ssids.some((ssid) => normalizeSsid(ssid) === normalizedText)
  );
  if (bySsid) {
    return { cld: bySsid.cld, matchedBy: "ssid", label: bySsid.label };
  }

  return null;
}

function mediaUrlFromFilePath(filePath) {
  const relative = path.relative(cldRootDir, filePath).split(path.sep).join("/");
  return `/media/cld/${relative}`;
}

function safeFileStem(value) {
  const stem = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return stem || "upload";
}

function extensionFromMimeType(mimeType) {
  switch (String(mimeType || "").toLowerCase()) {
    case "image/jpeg":
      return ".jpg";
    case "image/png":
      return ".png";
    case "image/heic":
    case "image/heif":
      return ".heic";
    case "image/webp":
      return ".webp";
    default:
      return ".jpg";
  }
}

async function compressImageWithImagemagick(sourcePath, targetPath) {
  await ensureDir(path.dirname(targetPath));
  await execFileAsync("magick", [
    sourcePath,
    "-auto-orient",
    "-strip",
    "-resize",
    "1600x1600>",
    "-quality",
    "75",
    targetPath
  ]);
}

async function createImageUpload(cld, payload) {
  const dataUrl = String(payload?.dataUrl || "");
  const mimeType = String(payload?.mimeType || "");
  const filename = String(payload?.filename || "capture.jpg");

  if (!dataUrl.startsWith("data:image/")) {
    throw new Error("Expected an image data URL");
  }

  const commaIndex = dataUrl.indexOf(",");
  if (commaIndex === -1) {
    throw new Error("Invalid image payload");
  }

  const binary = Buffer.from(dataUrl.slice(commaIndex + 1), "base64");
  if (binary.length === 0) {
    throw new Error("Image payload is empty");
  }

  const uploadId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const ext = extensionFromMimeType(mimeType);
  const regionDir = path.join(cldRootDir, cld);
  const uploadDir = path.join(regionDir, "media", "uploads");
  const originalName = `${uploadId}-${safeFileStem(path.parse(filename).name)}${ext}`;
  const originalPath = path.join(uploadDir, originalName);
  const compressedPath = path.join(uploadDir, `${uploadId}-compressed.jpg`);

  await ensureDir(uploadDir);
  await fs.writeFile(originalPath, binary);

  try {
    await compressImageWithImagemagick(originalPath, compressedPath);
  } catch {
    await fs.copyFile(originalPath, compressedPath);
  }

  return {
    uploadId,
    mimeType,
    originalUrl: mediaUrlFromFilePath(originalPath),
    compressedUrl: mediaUrlFromFilePath(compressedPath)
  };
}

function extractProxyTargetUrl(req) {
  const rawQuery = req.originalUrl.includes("?")
    ? req.originalUrl.slice(req.originalUrl.indexOf("?") + 1)
    : "";

  if (!rawQuery && req.query.target) {
    return String(req.query.target);
  }
  if (!rawQuery) {
    return "";
  }
  if (rawQuery.startsWith("http://") || rawQuery.startsWith("https://")) {
    return rawQuery;
  }
  if (rawQuery.startsWith("target=")) {
    return decodeURIComponent(rawQuery.slice(7));
  }
  try {
    return decodeURIComponent(rawQuery);
  } catch {
    return rawQuery;
  }
}

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

app.post("/api/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "Username and password required" });
  }
  try {
    const { rows } = await pool.query("SELECT * FROM users WHERE username = $1 LIMIT 1;", [username]);
    if (rows.length === 0) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const user = rows[0];
    const match = await bcrypt.compare(password, user.password_hash);
    if (!match) {
      return res.status(401).json({ error: "Invalid credentials" });
    }
    const token = jwt.sign({ id: user.id, username: user.username }, jwtSecret, { expiresIn: "30d" });
    res.cookie(AUTH_COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", maxAge: 30 * 24 * 60 * 60 * 1000 });
    const authUser = await loadUserById(user.id);
    res.json({
      ok: true,
      user: authUser || {
        id: user.id,
        username: user.username,
        isAdmin: Boolean(user.is_admin),
        role: normalizeUserRole(user.role)
      }
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/logout", (req, res) => {
  res.clearCookie(AUTH_COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.status(401).json({ error: "Not logged in" });
  res.json({ user });
});

app.get("/api/admin/users", requireUserManagementAccess, async (req, res) => {
  try {
    const currentUser = req.user;
    const managedIds = await getManagedUserIds(currentUser);
    const { rows } = await pool.query(`
      SELECT id, username, is_admin, role, created_at
      FROM users
      ORDER BY username;
    `);
    const visibleRows = isAdminUser(currentUser)
      ? rows
      : rows.filter((row) => managedIds.includes(row.id));
    const users = [];
    for (const row of visibleRows) {
      users.push({
        id: row.id,
        username: row.username,
        isAdmin: Boolean(row.is_admin || row.role === "admin"),
        role: normalizeUserRole(row.role || (row.is_admin ? "admin" : "enumerator")),
        createdAt: row.created_at,
        allowedClds: await getDirectAllowedClds(row.id),
        crewLeaderIds: await getCrewLeaderIdsForUser(row.id),
        crewLeaders: await getCrewLeaderUsersForUser(row.id),
        managedUserIds: row.role === "crew_leader" ? await getManagedUsersForCrewLeader(row.id) : []
      });
    }
    res.json({ users });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post("/api/admin/users", requireUserManagementAccess, async (req, res) => {
  const { username, password, isAdmin, role, allowedClds, crewLeaderIds } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Username and password required" });
  try {
    const currentUser = req.user;
    const resolvedRole = isAdmin ? "admin" : normalizeUserRole(role);
    if (!isAdminUser(currentUser) && resolvedRole !== "enumerator") {
      return res.status(403).json({ error: "Crew leaders can only create enumerators" });
    }
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      "INSERT INTO users (username, password_hash, is_admin, role) VALUES ($1, $2, $3, $4) RETURNING id;",
      [username, hash, Boolean(isAdmin), resolvedRole]
    );
    const userId = rows[0].id;
    if (isAdminUser(currentUser) && Array.isArray(allowedClds) && resolvedRole !== "admin") {
      for (const cld of allowedClds) {
        await pool.query("INSERT INTO user_clds (user_id, cld) VALUES ($1, $2);", [userId, cld]);
      }
    }
    const crewLeaderSet = new Set();
    if (!isAdminUser(currentUser)) {
      crewLeaderSet.add(Number(currentUser.id));
    } else if (Array.isArray(crewLeaderIds)) {
      for (const crewLeaderId of await resolveUserIdsFromRefs(crewLeaderIds)) {
        crewLeaderSet.add(crewLeaderId);
      }
    }
    for (const crewLeaderId of crewLeaderSet) {
      await pool.query(
        "INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
        [userId, crewLeaderId]
      );
    }
    res.status(201).json({ ok: true, userId });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.put("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
  const userId = Number(req.params.id);
  const { password, isAdmin, role, allowedClds, crewLeaderIds } = req.body;
  try {
    const currentUser = req.user;
    const { rows: targetRows } = await pool.query("SELECT id, username, is_admin, role FROM users WHERE id = $1 LIMIT 1;", [userId]);
    if (targetRows.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }
    const target = targetRows[0];
    const targetRole = normalizeUserRole(target.role || (target.is_admin ? "admin" : "enumerator"));
    const managedIds = new Set(await getManagedUserIds(currentUser));
    if (!isAdminUser(currentUser) && !managedIds.has(userId)) {
      return res.status(403).json({ error: "You cannot manage this user" });
    }
    if (!isAdminUser(currentUser) && userId !== Number(currentUser.id) && targetRole !== "enumerator") {
      return res.status(403).json({ error: "Crew leaders can only manage enumerators" });
    }

    const nextRole = isAdmin ? "admin" : normalizeUserRole(role || targetRole);
    if (!isAdminUser(currentUser) && nextRole !== targetRole) {
      return res.status(403).json({ error: "Crew leaders cannot change user roles" });
    }

    if (password) {
      const hash = await bcrypt.hash(password, 10);
      await pool.query("UPDATE users SET password_hash = $1 WHERE id = $2;", [hash, userId]);
    }

    await pool.query("UPDATE users SET is_admin = $1, role = $2 WHERE id = $3;", [Boolean(nextRole === "admin"), nextRole, userId]);

    if (isAdminUser(currentUser)) {
      await pool.query("DELETE FROM user_clds WHERE user_id = $1;", [userId]);
      if (Array.isArray(allowedClds) && nextRole !== "admin") {
        for (const cld of allowedClds) {
          await pool.query("INSERT INTO user_clds (user_id, cld) VALUES ($1, $2);", [userId, cld]);
        }
      }

      await pool.query("DELETE FROM user_crew_leaders WHERE user_id = $1;", [userId]);
      if (Array.isArray(crewLeaderIds) && nextRole === "enumerator") {
        for (const crewLeaderId of await resolveUserIdsFromRefs(crewLeaderIds)) {
          await pool.query(
            "INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
            [userId, crewLeaderId]
          );
        }
      }
    } else if (currentUser.role === "crew_leader" && userId !== Number(currentUser.id)) {
      await pool.query(
        "INSERT INTO user_crew_leaders (user_id, crew_leader_id) VALUES ($1, $2) ON CONFLICT DO NOTHING;",
        [userId, Number(currentUser.id)]
      );
    }

    res.json({ ok: true });
  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});

app.delete("/api/admin/users/:id", requireUserManagementAccess, async (req, res) => {
  const userId = Number(req.params.id);
  if (req.user.id === userId) return res.status(400).json({ error: "Cannot delete yourself" });
  try {
    if (!isAdminUser(req.user)) {
      const managedIds = new Set(await getManagedUserIds(req.user));
      if (!managedIds.has(userId)) {
        return res.status(403).json({ error: "You cannot delete this user" });
      }
    }
    await pool.query("DELETE FROM users WHERE id = $1;", [userId]);
    res.json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
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

app.get("/api/lookup", async (req, res) => {
  const queryValue = String(req.query.q || "").trim();
  if (!queryValue) {
    return res.status(400).json({ error: "Lookup query is required" });
  }
  const result = await resolveClDFromLookup(queryValue);
  if (!result) {
    return res.status(404).json({ error: "CLD not found" });
  }
  return res.json(result);
});

app.get("/api/regions", async (_req, res) => {
  const records = await buildLookupRecords();
  res.json({ regions: records });
});

app.get("/api/cld/:cld", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  try {
    const bundle = await readRegionBundle(cld);
    return res.json(summarizeRegion(bundle.index, bundle));
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.get("/api/cld/:cld/features", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  try {
    const bundle = await readRegionBundle(cld);
    return res.json(buildFeatureCollection([
      ...bundle.cu,
      ...bundle.blocks,
      ...bundle.dwellings
    ]));
  } catch (error) {
    return res.status(404).json({ error: error.message });
  }
});

app.post("/api/cld/:cld/features", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }

  try {
    const features = normalizeFeatures(req.body);
    if (features.length !== 1) {
      return res.status(400).json({ error: "Send exactly one GeoJSON Feature in request body" });
    }
    const id = await createRegionFeature(cld, features[0]);
    return res.status(201).json({ ok: true, inserted: 1, ids: [id] });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.put("/api/cld/:cld/features/:id", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  const id = Number(req.params.id);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid feature id" });
  }
  try {
    const features = normalizeFeatures(req.body);
    if (features.length !== 1) {
      return res.status(400).json({ error: "Send exactly one GeoJSON Feature in request body" });
    }
    const updated = await updateRegionFeature(cld, id, features[0]);
    if (!updated) {
      return res.status(404).json({ error: "Feature not found" });
    }
    return res.json({ ok: true, updatedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.delete("/api/cld/:cld/features/:id", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  const id = Number(req.params.id);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  if (!Number.isFinite(id)) {
    return res.status(400).json({ error: "Invalid feature id" });
  }
  try {
    const deleted = await deleteRegionFeature(cld, id);
    if (!deleted) {
      return res.status(404).json({ error: "Feature not found" });
    }
    return res.json({ ok: true, deletedId: id });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.post("/api/cld/:cld/uploads", requireAuth, requireClDAccess, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  try {
    if (!(await regionExists(cld))) {
      return res.status(404).json({ error: `Unknown CLD ${cld}` });
    }
    await ensureRegionMediaDirs(cld);
    const upload = await createImageUpload(cld, req.body || {});
    return res.status(201).json({ ok: true, upload });
  } catch (error) {
    return res.status(400).json({ error: error.message });
  }
});

app.get("/api/arcgis-proxy*", async (req, res) => {
  const targetUrl = extractProxyTargetUrl(req);
  if (!targetUrl) {
    return res.status(400).json({ error: "Proxy target URL is required" });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return res.status(400).json({ error: "Invalid target URL" });
  }

  const allowedHosts = new Set(["geoprod.statcan.gc.ca", "geo.statcan.gc.ca"]);
  if (mapConfig.cmp.arcgis.url) {
    try {
      allowedHosts.add(new URL(mapConfig.cmp.arcgis.url).hostname);
    } catch {
      // Ignore invalid configured proxy host.
    }
  }
  if (!allowedHosts.has(parsed.hostname)) {
    return res.status(403).json({ error: "Target host is not allowed" });
  }

  const upstreamHeaders = {
    "user-agent": req.headers["user-agent"] || "selfhost-map-cmp-proxy/1.0",
    accept: req.headers.accept || "*/*"
  };
  if (process.env.CMP_ARCGIS_COOKIE) {
    upstreamHeaders.cookie = process.env.CMP_ARCGIS_COOKIE;
  }

  try {
    const upstream = await fetch(targetUrl, { method: "GET", headers: upstreamHeaders });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const contentType = upstream.headers.get("content-type");
    if (contentType) {
      res.setHeader("content-type", contentType);
    }
    const cacheControl = upstream.headers.get("cache-control");
    if (cacheControl) {
      res.setHeader("cache-control", cacheControl);
    }
    return res.status(upstream.status).send(buffer);
  } catch (error) {
    return res.status(502).json({ error: `Proxy request failed: ${error.message}` });
  }
});

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
        await assertDwellingNoUnique(normalized, store.features);
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
      await assertDwellingNoUnique(features[0], store.features, id);
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

app.get("/statcan", (_req, res) => {
  res.sendFile(path.join(publicDir, "statcan.html"));
});

app.get("/login", (_req, res) => {
  res.sendFile(path.join(publicDir, "login.html"));
});

app.get("/users", requireUserManagementAccess, (_req, res) => {
  res.sendFile(path.join(publicDir, "users.html"));
});

app.get("/", async (req, res) => {
  const user = await getUser(req);
  if (!user) return res.redirect("/login");
  res.sendFile(path.join(publicDir, "landing.html"));
});

app.get("/:cld/edit", requireAuth, requireClDAccess, async (req, res, next) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) return next();
  if (!(await regionExists(cld))) {
    return res.status(404).sendFile(path.join(publicDir, "landing.html"));
  }
  return res.sendFile(path.join(publicDir, "edit.html"));
});

app.use(express.static(publicDir));

app.get("/:cld", requireAuth, requireClDAccess, async (req, res, next) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) return next();
  if (!(await regionExists(cld))) {
    return res.status(404).sendFile(path.join(publicDir, "landing.html"));
  }
  return res.sendFile(path.join(publicDir, "index.html"));
});

app.get("*", (_req, res) => {
  res.redirect("/");
});

const startup = useFileStore ? ensureFileStore() : initDb();

startup
  .then(async () => {
    if (useFileStore) {
      await migrateLegacyDataToClDStore();
    }
    app.listen(port, () => {
      console.log(`Map app is running on port ${port} (${useFileStore ? "file-store mode" : "postgis mode"})`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize app:", error);
    process.exit(1);
  });
