import { Pool } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import { createApp, registerErrorHandler, registerPublicAssets } from "./app.js";
import { registerSystemRoutes } from "./routes/system-routes.js";
import { registerRegionRoutes } from "./routes/region-routes.js";
import { registerTileRoutes } from "./routes/tile-routes.js";
import { registerAuthRoutes } from "./routes/auth-routes.js";
import { registerUserRoutes } from "./routes/user-routes.js";
import { assertDwellingNoUnique, classifyRegionFeature, createRegionMutationService, summarizeRegion } from "./services/region-service.js";
import { registerPageRoutes } from "./routes/page-routes.js";
import { registerLegacyFeatureRoutes } from "./routes/legacy-feature-routes.js";
import { createRegionRepository } from "./repositories/region-repository.js";
import { createPostgisRegionRepository } from "./repositories/postgis-region-repository.js";
import { createFileRegionRepository } from "./repositories/file-region-repository.js";
import { ensureDir, exists, readJsonFile, writeJsonFile } from "./infrastructure/json-files.js";
import {
  buildFeatureCollection,
  extractClDFromProperties,
  extractCuCode,
  featureFileNames,
  hasText,
  normalizeClD,
  normalizeDwellingNo,
  normalizeFeatures,
  normalizeRegionFeature,
  normalizeSsid,
  uniqueSorted
} from "./domain/region-feature.js";

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.join(__dirname, "..", "..");
const publicDir = path.join(__dirname, "..", "public");
const dataDir = path.resolve(process.env.DATA_DIR || path.join(repoRoot, "data"));
const cldRootDir = path.join(dataDir, "cld");

export const app = createApp({
  cldRootDir,
  nodeModulesDir: path.join(__dirname, "..", "node_modules")
});
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
const postgisRegionRepository = useFileStore ? null : createPostgisRegionRepository(pool);
const fileRegionRepository = useFileStore ? createFileRegionRepository(cldRootDir) : null;

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

const AUTH_COOKIE = "census_session";
const USER_ROLES = new Set(["admin", "crew_leader", "enumerator"]);

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
      WHERE cld = $2 OR cld = '0000'
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
        revision BIGINT NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
    `);
    await client.query("ALTER TABLE cld_regions ADD COLUMN IF NOT EXISTS revision BIGINT NOT NULL DEFAULT 1;");
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
    return fileRegionRepository.exists(cld);
  }
  return postgisRegionRepository.exists(cld);
}

async function ensureRegionMediaDirs(cld) {
  if (useFileStore) {
    await fileRegionRepository.ensureMediaDirs(cld);
    return;
  }
  const regionDir = path.join(cldRootDir, cld);
  await ensureDir(path.join(regionDir, "media", "dwellings"));
  await ensureDir(path.join(regionDir, "media", "uploads"));
}

async function syncRegionCuCodes(cld) {
  await postgisRegionRepository.syncCuCodes(cld);
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
  await fileRegionRepository.ensureRegion(cld);
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
    const featureType = classifyRegionFeature(normalized);
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
      revision: 1,
      nextFeatureId: bucket.maxId + 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
    await writeJsonFile(path.join(regionDir, "cu.geojson"), buildFeatureCollection(bucket.cu));
    await writeJsonFile(path.join(regionDir, "blocks.geojson"), buildFeatureCollection(bucket.blocks));
    await writeJsonFile(path.join(regionDir, "dwellings.geojson"), buildFeatureCollection(bucket.dwellings));
  }
}

async function readRegionBundle(cld) {
  if (useFileStore) {
    await ensureEmptyRegionFiles(cld);
  }
  if (useFileStore) return fileRegionRepository.readBundle(cld);
  return postgisRegionRepository.readBundle(cld);
}

async function buildLookupRecords() {
  const repository = useFileStore ? fileRegionRepository : postgisRegionRepository;
  const indexes = await repository.listIndexes();
  return indexes.map((index) => ({
    cld: index.cld,
    label: index.label || `CLD ${index.cld}`,
    ssids: Array.isArray(index.ssids) ? index.ssids : [],
    cuCodes: Array.isArray(index.cuCodes) ? index.cuCodes : []
  }));
}

async function resolveClDFromLookup(queryValue) {
  const repository = useFileStore ? fileRegionRepository : postgisRegionRepository;
  return repository.resolveLookup(queryValue);
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

registerSystemRoutes(app, {
  buildLookupRecords,
  ensureFileStore,
  pool,
  resolveClDFromLookup,
  useFileStore
});

registerAuthRoutes(app, {
  authCookie: AUTH_COOKIE,
  bcrypt,
  getUser,
  isAdminUser,
  jwt,
  jwtSecret,
  loadUserById,
  mapConfig,
  normalizeUserRole,
  pool,
  requireAuth,
  secureCookies: process.env.NODE_ENV === "production"
});


registerUserRoutes(app, {
  bcrypt, getCrewLeaderIdsForUser, getCrewLeaderUsersForUser, getDirectAllowedClds,
  getManagedUserIds, getManagedUsersForCrewLeader, isAdminUser, normalizeUserRole,
  pool, requireUserManagementAccess, resolveUserIdsFromRefs
});



const activeRegionStorage = useFileStore ? fileRegionRepository : postgisRegionRepository;
const regionMutations = createRegionMutationService({
  createFeature: (cld, type, feature, expectedRevision) => activeRegionStorage.createFeature(cld, type, feature, expectedRevision),
  deleteFeature: (cld, type, id, expectedRevision) => useFileStore
    ? activeRegionStorage.deleteFeature(cld, type, id, expectedRevision)
    : activeRegionStorage.deleteFeature(cld, id, expectedRevision),
  exists: regionExists,
  findFeature: (cld, id) => activeRegionStorage.findFeature(cld, id),
  readFeatures: (cld, type) => activeRegionStorage.readFeatures(cld, type),
  syncCuCodes: useFileStore ? undefined : syncRegionCuCodes,
  updateFeature: (cld, type, id, feature, expectedRevision) => useFileStore
    ? activeRegionStorage.updateFeature(cld, type, id, feature, expectedRevision)
    : activeRegionStorage.updateFeature(cld, id, feature, expectedRevision)
});
const {
  createFeature: createRegionFeature,
  deleteFeature: deleteRegionFeature,
  updateFeature: updateRegionFeature
} = regionMutations;

const regionRepository = createRegionRepository({
  createFeature: createRegionFeature,
  createImageUpload,
  deleteFeature: deleteRegionFeature,
  ensureMediaDirs: ensureRegionMediaDirs,
  exists: regionExists,
  readBundle: readRegionBundle,
  updateFeature: updateRegionFeature
});

registerRegionRoutes(app, {
  buildFeatureCollection,
  extractCuCode,
  normalizeClD,
  normalizeDwellingNo,
  normalizeFeatures,
  pool,
  repository: regionRepository,
  requireAuth,
  requireClDAccess,
  summarizeRegion,
  useFileStore
});


registerTileRoutes(app, {
  arcgisCookie: process.env.CMP_ARCGIS_COOKIE,
  extractProxyTargetUrl,
  mapConfig,
  tileProxyUserAgent: process.env.TILE_PROXY_USER_AGENT
});


registerLegacyFeatureRoutes(app, {
  assertDwellingNoUnique, buildFeatureCollection, createRegionFeature, normalizeClD,
  normalizeFeatures, normalizeRegionFeature, pool, readFileStore, useFileStore, writeFileStore
});


const registerViewerRoute = registerPageRoutes(app, {
  getUser, normalizeClD, publicDir, regionExists, requireAdmin, requireAuth,
  requireClDAccess, requireUserManagementAccess
});


registerPublicAssets(app, publicDir);

registerViewerRoute(app);

app.get("*", (_req, res) => {
  res.redirect("/");
});

registerErrorHandler(app);

async function initializeApp() {
  if (useFileStore) {
    await ensureFileStore();
    await migrateLegacyDataToClDStore();
    return;
  }
  await initDb();
}

export async function startServer({ listenPort = port } = {}) {
  await initializeApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(listenPort, () => {
      console.log(`Map app is running on port ${listenPort} (${useFileStore ? "file-store mode" : "postgis mode"})`);
      resolve(server);
    });
    server.once("error", reject);
  });
}

export async function stopServer(server) {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  if (pool) await pool.end();
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  startServer().catch((error) => {
    console.error("Failed to initialize app:", error);
    process.exit(1);
  });
}
