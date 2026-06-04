import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { Pool } from "pg";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

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
const editUsername = String(process.env.EDIT_USERNAME || "admin").trim();
const editPassword = String(process.env.EDIT_PASSWORD || "").trim();

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
app.use("/vendor/leaflet", express.static(path.join(__dirname, "..", "node_modules", "leaflet", "dist")));
app.use("/vendor/leaflet-draw", express.static(path.join(__dirname, "..", "node_modules", "leaflet-draw", "dist")));
app.use("/vendor/esri-leaflet", express.static(path.join(__dirname, "..", "node_modules", "esri-leaflet", "dist")));
app.use("/media/cld", express.static(cldRootDir));

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

function readBasicAuthCredentials(headerValue) {
  if (!hasText(headerValue) || !String(headerValue).startsWith("Basic ")) return "";
  try {
    const decoded = Buffer.from(String(headerValue).slice(6), "base64").toString("utf8");
    const separatorIndex = decoded.indexOf(":");
    if (separatorIndex === -1) {
      return { username: decoded, password: "" };
    }
    return {
      username: decoded.slice(0, separatorIndex),
      password: decoded.slice(separatorIndex + 1)
    };
  } catch {
    return { username: "", password: "" };
  }
}

function requireEditAuth(req, res, next) {
  if (!editPassword) return next();
  const provided = readBasicAuthCredentials(req.headers.authorization);
  if (provided.username === editUsername && provided.password === editPassword) return next();
  res.setHeader("WWW-Authenticate", 'Basic realm="CLD Editor"');
  return res.status(401).json({ error: "Editor authentication required" });
}

function buildFeatureCollection(features) {
  return {
    type: "FeatureCollection",
    features: Array.isArray(features) ? features : []
  };
}

function normalizeFeatures(payload) {
  if (!payload) return [];
  if (payload.type === "FeatureCollection" && Array.isArray(payload.features)) {
    return payload.features;
  }
  if (payload.type === "Feature") {
    return [payload];
  }
  if (Array.isArray(payload)) {
    return payload.filter((item) => item?.type === "Feature");
  }
  return [];
}

function extractCuCode(properties) {
  if (!properties || typeof properties !== "object") return "";
  if (hasText(properties.CUID)) return String(properties.CUID).trim();
  if (hasText(properties.cu)) return String(properties.cu).trim();
  if (hasText(properties.name)) return String(properties.name).split("/")[0].trim();
  if (hasText(properties.label)) return String(properties.label).split("/")[0].trim();
  return "";
}

function extractClDFromProperties(properties) {
  if (!properties || typeof properties !== "object") return "";
  const raw = properties.CLD ?? properties.cld ?? properties.CFOP_CLD_ID ?? properties.cfopCldId;
  return normalizeClD(raw);
}

function isCuFeature(properties) {
  if (!properties || typeof properties !== "object") return false;
  const group = String(properties._group || "").trim().toLowerCase();
  if (group === "cu" || group === "cus") return true;
  return hasText(properties.CU_TYPE) && !hasText(properties.COLB_UID) && !hasText(properties.CB_COLCODE);
}

function isBlockFeature(properties) {
  if (!properties || typeof properties !== "object") return false;
  const group = String(properties._group || "").trim().toLowerCase();
  if (group === "blocks" || group === "block") return true;
  return hasText(properties.COLB_UID) || hasText(properties.CB_COLCODE);
}

function isDwellingFeature(properties, geometry = null) {
  if (!properties || typeof properties !== "object") return false;
  const group = String(properties._group || "").trim().toLowerCase();
  if (group === "dwellings" || group === "dwelling") return true;
  const rawDwellingNo = properties.dwellingNo ?? properties.DWELLING_NO ?? properties.vrNumber ?? properties.VR_NUMBER;
  return hasText(rawDwellingNo) && geometry?.type === "Point";
}

function classifyFeature(feature) {
  const properties = feature?.properties || {};
  const geometry = feature?.geometry || {};
  if (isDwellingFeature(properties, geometry)) return "dwellings";
  if (isBlockFeature(properties)) return "blocks";
  if (isCuFeature(properties)) return "cu";
  return "other";
}

function normalizeRegionFeature(feature) {
  const properties = feature?.properties && typeof feature.properties === "object"
    ? { ...feature.properties }
    : {};
  return {
    type: "Feature",
    ...(feature?.id !== undefined ? { id: feature.id } : {}),
    properties,
    geometry: feature?.geometry || null
  };
}

function featureFileNames() {
  return {
    cu: "cu.geojson",
    blocks: "blocks.geojson",
    dwellings: "dwellings.geojson"
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

async function ensureDir(targetPath) {
  await fs.mkdir(targetPath, { recursive: true });
}

async function readJsonFile(filePath, fallback = null) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(filePath, value) {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function initDb() {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS postgis;");
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
  const regionDir = path.join(cldRootDir, cld);
  const names = featureFileNames();
  await ensureDir(path.join(regionDir, "media", "dwellings"));
  await ensureDir(path.join(regionDir, "media", "uploads"));
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
  await ensureDir(cldRootDir);
  const entries = await fs.readdir(cldRootDir, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => /^[0-9]+$/.test(name))
    .sort();
}

async function readRegionIndex(cld) {
  const regionDir = path.join(cldRootDir, cld);
  const index = await readJsonFile(path.join(regionDir, "index.json"), null);
  if (!index) {
    throw new Error(`Unknown CLD ${cld}`);
  }
  return index;
}

async function writeRegionIndex(cld, index) {
  const regionDir = path.join(cldRootDir, cld);
  await writeJsonFile(path.join(regionDir, "index.json"), {
    ...index,
    cld,
    updatedAt: new Date().toISOString()
  });
}

async function readRegionFeatures(cld, type) {
  const names = featureFileNames();
  const fileName = names[type];
  if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
  const filePath = path.join(cldRootDir, cld, fileName);
  const parsed = await readJsonFile(filePath, buildFeatureCollection([]));
  const features = Array.isArray(parsed?.features) ? parsed.features : [];
  return features.map((feature) => normalizeRegionFeature(feature));
}

async function writeRegionFeatures(cld, type, features) {
  const names = featureFileNames();
  const fileName = names[type];
  if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
  const filePath = path.join(cldRootDir, cld, fileName);
  await writeJsonFile(filePath, buildFeatureCollection(features.map((feature) => normalizeRegionFeature(feature))));
}

async function readRegionBundle(cld) {
  await ensureEmptyRegionFiles(cld);
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

  const index = await readRegionIndex(cld);
  const type = inferFileTypeFromFeature(normalized);
  const collection = await readRegionFeatures(cld, type);
  const dwellings = type === "dwellings" ? collection : await readRegionFeatures(cld, "dwellings");
  await assertDwellingNoUnique(normalized, dwellings);

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
  await writeRegionFeatures(cld, existing.type, next);
  return true;
}

async function buildLookupRecords() {
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

app.get("/api/config", (_req, res) => {
  res.json({
    ...mapConfig,
    auth: {
      editProtected: Boolean(editPassword)
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

app.get("/api/cld/:cld", async (req, res) => {
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

app.get("/api/cld/:cld/features", async (req, res) => {
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

app.post("/api/cld/:cld/features", requireEditAuth, async (req, res) => {
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

app.put("/api/cld/:cld/features/:id", requireEditAuth, async (req, res) => {
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

app.delete("/api/cld/:cld/features/:id", requireEditAuth, async (req, res) => {
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

app.post("/api/cld/:cld/uploads", requireEditAuth, async (req, res) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) {
    return res.status(400).json({ error: "Invalid CLD" });
  }
  try {
    await ensureEmptyRegionFiles(cld);
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

app.get("/", (_req, res) => {
  res.sendFile(path.join(publicDir, "landing.html"));
});

app.get("/:cld/edit", requireEditAuth, async (req, res, next) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) return next();
  if (!(await exists(path.join(cldRootDir, cld, "index.json")))) {
    return res.status(404).sendFile(path.join(publicDir, "landing.html"));
  }
  return res.sendFile(path.join(publicDir, "edit.html"));
});

app.use(express.static(publicDir));

app.get("/:cld", async (req, res, next) => {
  const cld = normalizeClD(req.params.cld);
  if (!cld) return next();
  if (!(await exists(path.join(cldRootDir, cld, "index.json")))) {
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
    await migrateLegacyDataToClDStore();
    app.listen(port, () => {
      console.log(`Map app is running on port ${port} (${useFileStore ? "file-store mode" : "postgis mode"})`);
    });
  })
  .catch((error) => {
    console.error("Failed to initialize app:", error);
    process.exit(1);
  });
