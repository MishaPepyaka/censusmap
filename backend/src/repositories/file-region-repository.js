import fs from "node:fs/promises";
import path from "node:path";
import { buildFeatureCollection, extractCuCode, featureFileNames, normalizeClD, normalizeRegionFeature, normalizeSsid } from "../domain/region-feature.js";
import { ensureDir, exists, readJsonFile, writeJsonFile } from "../infrastructure/json-files.js";

export function createFileRegionRepository(cldRootDir) {
  const indexPath = (cld) => path.join(cldRootDir, cld, "index.json");
  const featurePath = (cld, type) => {
    const fileName = featureFileNames()[type];
    if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
    return path.join(cldRootDir, cld, fileName);
  };

  async function readIndex(cld) {
    const index = await readJsonFile(indexPath(cld), null);
    if (!index) throw new Error(`Unknown CLD ${cld}`);
    return index;
  }

  async function readFeatures(cld, type) {
    const parsed = await readJsonFile(featurePath(cld, type), buildFeatureCollection([]));
    return (Array.isArray(parsed?.features) ? parsed.features : []).map(normalizeRegionFeature);
  }

  async function ensureMediaDirs(cld) {
    const regionDir = path.join(cldRootDir, cld);
    await Promise.all([
      ensureDir(path.join(regionDir, "media", "dwellings")),
      ensureDir(path.join(regionDir, "media", "uploads"))
    ]);
  }

  async function listIndexes() {
    await ensureDir(cldRootDir);
    const entries = await fs.readdir(cldRootDir, { withFileTypes: true }).catch(() => []);
    const clds = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => /^[0-9]+$/.test(name))
      .sort();
    const indexes = await Promise.all(clds.map((cld) => readJsonFile(indexPath(cld), null)));
    return indexes.filter(Boolean);
  }

  async function resolveLookup(queryValue) {
    const normalizedDigits = normalizeClD(queryValue);
    const normalizedText = normalizeSsid(queryValue);
    const records = await listIndexes();
    const directClD = records.find((record) => record.cld === normalizedDigits);
    if (directClD) return { cld: directClD.cld, matchedBy: "cld", label: directClD.label || `CLD ${directClD.cld}` };
    const byCu = records.find((record) => (Array.isArray(record.cuCodes) ? record.cuCodes : []).includes(normalizedDigits));
    if (byCu) return { cld: byCu.cld, matchedBy: "cu", label: byCu.label || `CLD ${byCu.cld}` };
    const bySsid = records.find((record) => (Array.isArray(record.ssids) ? record.ssids : []).some((ssid) => normalizeSsid(ssid) === normalizedText));
    return bySsid ? { cld: bySsid.cld, matchedBy: "ssid", label: bySsid.label || `CLD ${bySsid.cld}` } : null;
  }

  return Object.freeze({
    exists(cld) {
      return exists(indexPath(cld));
    },
    async ensureRegion(cld) {
      await ensureMediaDirs(cld);
      await Promise.all(Object.keys(featureFileNames()).map(async (type) => {
        const filePath = featurePath(cld, type);
        if (!(await exists(filePath))) {
          await writeJsonFile(filePath, buildFeatureCollection([]));
        }
      }));
      if (!(await exists(indexPath(cld)))) {
        await writeJsonFile(indexPath(cld), {
          cld,
          label: `CLD ${cld}`,
          ssids: [],
          cuCodes: [],
          nextFeatureId: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString()
        });
      }
    },
    ensureMediaDirs,
    listIndexes,
    resolveLookup,
    readIndex,
    readFeatures,
    async findFeature(cld, id) {
      const bundle = await this.readBundle(cld);
      for (const type of ["cu", "blocks", "dwellings"]) {
        const feature = bundle[type].find((item) => Number(item?.id) === Number(id));
        if (feature) return { type, feature };
      }
      return null;
    },
    async createFeature(cld, type, feature) {
      const index = await readIndex(cld);
      const nextId = Number.isFinite(Number(index.nextFeatureId)) ? Number(index.nextFeatureId) : 1;
      const normalized = normalizeRegionFeature({ ...feature, id: nextId });
      const features = await readFeatures(cld, type);
      features.push(normalized);
      await writeJsonFile(featurePath(cld, type), buildFeatureCollection(features));
      if (type !== "dwellings") {
        const cuCodes = new Set(Array.isArray(index.cuCodes) ? index.cuCodes : []);
        const cuCode = extractCuCode(normalized.properties || {});
        if (cuCode) cuCodes.add(cuCode);
        index.cuCodes = [...cuCodes].sort();
      }
      index.nextFeatureId = nextId + 1;
      await writeJsonFile(indexPath(cld), { ...index, cld, updatedAt: new Date().toISOString() });
      return nextId;
    },
    async readBundle(cld) {
      const [index, cu, blocks, dwellings] = await Promise.all([
        readIndex(cld), readFeatures(cld, "cu"), readFeatures(cld, "blocks"), readFeatures(cld, "dwellings")
      ]);
      return { index, cu, blocks, dwellings };
    },
    async writeIndex(cld, index) {
      await writeJsonFile(indexPath(cld), {
        ...index,
        cld,
        updatedAt: new Date().toISOString()
      });
    },
    writeFeatures(cld, type, features) {
      return writeJsonFile(featurePath(cld, type), buildFeatureCollection(features.map((feature) => normalizeRegionFeature(feature))));
    }
  });
}
