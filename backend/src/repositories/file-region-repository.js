import path from "node:path";
import { buildFeatureCollection, featureFileNames, normalizeRegionFeature } from "../domain/region-feature.js";
import { exists, readJsonFile } from "../infrastructure/json-files.js";

export function createFileRegionRepository(cldRootDir) {
  return Object.freeze({
    exists(cld) {
      return exists(path.join(cldRootDir, cld, "index.json"));
    },
    async readIndex(cld) {
      const index = await readJsonFile(path.join(cldRootDir, cld, "index.json"), null);
      if (!index) throw new Error(`Unknown CLD ${cld}`);
      return index;
    },
    async readFeatures(cld, type) {
      const fileName = featureFileNames()[type];
      if (!fileName) throw new Error(`Unsupported region file type: ${type}`);
      const parsed = await readJsonFile(path.join(cldRootDir, cld, fileName), buildFeatureCollection([]));
      return (Array.isArray(parsed?.features) ? parsed.features : []).map(normalizeRegionFeature);
    },
    async readBundle(cld) {
      const [index, cu, blocks, dwellings] = await Promise.all([
        this.readIndex(cld), this.readFeatures(cld, "cu"), this.readFeatures(cld, "blocks"), this.readFeatures(cld, "dwellings")
      ]);
      return { index, cu, blocks, dwellings };
    }
  });
}
