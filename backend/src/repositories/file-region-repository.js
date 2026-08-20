import path from "node:path";
import { buildFeatureCollection, featureFileNames, normalizeRegionFeature } from "../domain/region-feature.js";
import { exists, readJsonFile, writeJsonFile } from "../infrastructure/json-files.js";

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

  return Object.freeze({
    exists(cld) {
      return exists(indexPath(cld));
    },
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
