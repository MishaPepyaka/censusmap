import { classifyFeature, getDwellingIdentity, isSpecialLocationFeature } from "../domain/region-feature.js";

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
