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

export function createRegionStorageAdapter({ fileRepository, postgisRepository, ensurePostgisMediaDirs, useFileStore }) {
  const activeRepository = useFileStore ? fileRepository : postgisRepository;
  if (!activeRepository) throw new TypeError("Region storage adapter requires the active repository");
  if (!useFileStore && typeof ensurePostgisMediaDirs !== "function") {
    throw new TypeError("PostGIS region storage adapter requires ensurePostgisMediaDirs()");
  }

  return Object.freeze({
    createFeature(cld, type, feature, expectedRevision) {
      return activeRepository.createFeature(cld, type, feature, expectedRevision);
    },
    deleteFeature(cld, type, id, expectedRevision) {
      return useFileStore
        ? activeRepository.deleteFeature(cld, type, id, expectedRevision)
        : activeRepository.deleteFeature(cld, id, expectedRevision);
    },
    ensureMediaDirs(cld) {
      return useFileStore ? activeRepository.ensureMediaDirs(cld) : ensurePostgisMediaDirs(cld);
    },
    exists(cld) {
      return activeRepository.exists(cld);
    },
    findFeature(cld, id) {
      return activeRepository.findFeature(cld, id);
    },
    listIndexes() {
      return activeRepository.listIndexes();
    },
    async readBundle(cld) {
      if (useFileStore) await activeRepository.ensureRegion(cld);
      return activeRepository.readBundle(cld);
    },
    readFeatures(cld, type) {
      return activeRepository.readFeatures(cld, type);
    },
    resolveLookup(queryValue) {
      return activeRepository.resolveLookup(queryValue);
    },
    syncCuCodes(cld) {
      return useFileStore ? undefined : activeRepository.syncCuCodes(cld);
    },
    updateFeature(cld, type, id, feature, expectedRevision) {
      return useFileStore
        ? activeRepository.updateFeature(cld, type, id, feature, expectedRevision)
        : activeRepository.updateFeature(cld, id, feature, expectedRevision);
    }
  });
}
