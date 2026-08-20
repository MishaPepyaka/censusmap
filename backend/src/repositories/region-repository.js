const REQUIRED_METHODS = [
  "createFeature",
  "createImageUpload",
  "deleteFeature",
  "ensureMediaDirs",
  "exists",
  "readBundle",
  "updateFeature"
];

export function createRegionRepository(operations) {
  for (const method of REQUIRED_METHODS) {
    if (typeof operations?.[method] !== "function") {
      throw new TypeError(`RegionRepository requires ${method}()`);
    }
  }
  return Object.freeze({ ...operations });
}
