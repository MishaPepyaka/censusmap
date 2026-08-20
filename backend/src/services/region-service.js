import { assertValidRegionFeature, classifyFeature, getDwellingIdentity, isSpecialLocationFeature } from "../domain/region-feature.js";

export function assertDwellingNoUnique(feature, dwellings, excludeId = null) {
  const identity = getDwellingIdentity(feature?.properties || {});
  if (!identity) return;
  const { cuCode, dwellingNo } = identity;
  const conflict = dwellings.find((item) => {
    const itemId = Number(item?.id);
    if (Number.isFinite(excludeId) && itemId === Number(excludeId)) return false;
    const itemIdentity = getDwellingIdentity(item?.properties || {});
    return itemIdentity?.cuCode === cuCode && itemIdentity?.dwellingNo === dwellingNo;
  });
  if (conflict) {
    const suffix = Number.isFinite(Number(conflict.id)) ? ` (feature id ${conflict.id})` : "";
    throw new Error(`Dwelling ${dwellingNo} already exists in CU ${cuCode}${suffix}`);
  }
}

export function summarizeRegion(index, bundle) {
  return {
    cld: index.cld,
    revision: Number.isFinite(Number(index.revision)) ? Number(index.revision) : 1,
    label: index.label || `CLD ${index.cld}`,
    ssids: Array.isArray(index.ssids) ? index.ssids : [],
    cuCodes: Array.isArray(index.cuCodes) ? index.cuCodes : [],
    counts: {
      cu: bundle.cu.length,
      blocks: bundle.blocks.length,
      dwellings: bundle.dwellings.filter((feature) => !isSpecialLocationFeature(feature)).length,
      specialLocations: bundle.dwellings.filter(isSpecialLocationFeature).length
    }
  };
}

export function inferRegionFeatureType(feature) {
  const featureType = classifyFeature(feature);
  if (featureType === "cu" || featureType === "blocks" || featureType === "dwellings") return featureType;
  throw new Error("Unsupported feature type");
}

export function classifyRegionFeature(feature) {
  return classifyFeature(feature);
}

export function createRegionMutationService(storage) {
  const requiredMethods = ["createFeature", "deleteFeature", "exists", "findFeature", "readFeatures", "updateFeature"];
  for (const method of requiredMethods) {
    if (typeof storage?.[method] !== "function") throw new TypeError(`Region mutation storage requires ${method}()`);
  }

  async function createFeature(cld, feature, expectedRevision) {
    const normalized = assertValidRegionFeature(feature, cld);
    if (!(await storage.exists(cld))) throw new Error(`Unknown CLD ${cld}`);

    const type = inferRegionFeatureType(normalized);
    const collection = await storage.readFeatures(cld, type);
    const dwellings = type === "dwellings" ? collection : await storage.readFeatures(cld, "dwellings");
    assertDwellingNoUnique(normalized, dwellings);

    const id = await storage.createFeature(cld, type, normalized, expectedRevision);
    if (type === "cu") await storage.syncCuCodes?.(cld);
    return id;
  }

  async function updateFeature(cld, id, feature, expectedRevision) {
    if (!Number.isFinite(Number(id))) throw new Error("Invalid feature id");
    const normalized = assertValidRegionFeature(feature, cld);
    const existing = await storage.findFeature(cld, id);
    if (!existing) return false;

    const collection = await storage.readFeatures(cld, existing.type);
    normalized.id = Number(id);
    if (inferRegionFeatureType(normalized) !== existing.type) {
      throw new Error("Changing feature type is not supported");
    }

    const dwellings = existing.type === "dwellings" ? collection : await storage.readFeatures(cld, "dwellings");
    assertDwellingNoUnique(normalized, dwellings, Number(id));
    const updated = await storage.updateFeature(cld, existing.type, id, normalized, expectedRevision);
    if (updated && existing.type === "cu") await storage.syncCuCodes?.(cld);
    return updated;
  }

  async function deleteFeature(cld, id, expectedRevision) {
    if (!Number.isFinite(Number(id))) throw new Error("Invalid feature id");
    const existing = await storage.findFeature(cld, id);
    if (!existing) return false;
    const deleted = await storage.deleteFeature(cld, existing.type, id, expectedRevision);
    if (deleted && existing.type === "cu") await storage.syncCuCodes?.(cld);
    return deleted;
  }

  return Object.freeze({ createFeature, updateFeature, deleteFeature });
}
