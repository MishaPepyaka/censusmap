import fs from "node:fs/promises";
import path from "node:path";
import { buildFeatureCollection, featureFileNames, normalizeRegionFeature } from "../domain/region-feature.js";
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
    readIndex,
    readFeatures,
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
