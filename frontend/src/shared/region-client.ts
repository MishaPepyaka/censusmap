import { getJsonWithTimeout } from "./api.js";
import { isDwellingFeature, isSpecialLocationFeature, isZoneFeature, type RegionFeature } from "./map-data.js";
import { readCachedFeatures, saveCachedFeatures } from "./offline-data.js";

export type RegionSnapshotSource = "api" | "cache" | "none";
export type RegionSnapshot = {
  features: RegionFeature[];
  loadError: string;
  revision: number | null;
  source: RegionSnapshotSource;
};

export type RegionSummary = {
  cld: string;
  label: string;
  ssids: string[];
  counts: { cu: number; blocks: number; dwellings: number; specialLocations?: number };
  loadError?: string;
};

export function partitionRegionFeatures(features: RegionFeature[]) {
  return {
    zones: features.filter((feature) => isZoneFeature(feature)),
    dwellings: features.filter((feature) => isDwellingFeature(feature?.properties, feature?.geometry)),
    specialLocations: features.filter((feature) => isSpecialLocationFeature(feature?.properties, feature?.geometry))
  };
}

function isOnline(): boolean {
  return typeof navigator === "undefined" || navigator.onLine;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function asFeatures(payload: unknown): RegionFeature[] {
  if (!payload || typeof payload !== "object" || !Array.isArray((payload as { features?: unknown }).features)) return [];
  return (payload as { features: RegionFeature[] }).features;
}

function asRevision(payload: unknown): number | null {
  const revision = Number((payload as { revision?: unknown } | null)?.revision);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}

export async function loadRegionSnapshot(cld: string | number, { forceNetwork = false } = {}): Promise<RegionSnapshot> {
  const normalizedCld = String(cld);
  try {
    if (!isOnline()) throw new Error("Offline");
    const refresh = forceNetwork ? `?refresh=${Date.now()}` : "";
    const payload = await getJsonWithTimeout<unknown>(`/api/cld/${encodeURIComponent(normalizedCld)}/features${refresh}`, {}, 15000);
    const features = asFeatures(payload);
    if (features.length === 0) throw new Error("The map server returned an empty feature list");
    const revision = asRevision(payload);
    saveCachedFeatures(normalizedCld, features, revision);
    return { features, loadError: "", revision, source: "api" };
  } catch (error) {
    const snapshot = await readCachedFeatures(normalizedCld);
    const features = Array.isArray(snapshot?.features) ? snapshot.features as RegionFeature[] : [];
    if (features.length > 0) {
      return { features, loadError: "Offline: showing the last map saved on this device.", revision: asRevision(snapshot), source: "cache" };
    }
    return {
      features: [],
      loadError: isOnline()
        ? `Map data could not be loaded: ${errorMessage(error)}`
        : "Offline: application shell is ready. Connect once to download this CLD for offline use.",
      revision: null,
      source: "none"
    };
  }
}

export async function loadRegionSummary(cld: string | number): Promise<RegionSummary> {
  const normalizedCld = String(cld);
  const fallback: RegionSummary = {
    cld: normalizedCld,
    label: `CLD ${normalizedCld}`,
    ssids: [],
    counts: { cu: 0, blocks: 0, dwellings: 0 }
  };
  if (!isOnline()) return { ...fallback, loadError: "Offline" };
  try {
    return await getJsonWithTimeout<RegionSummary>(`/api/cld/${encodeURIComponent(normalizedCld)}`);
  } catch (error) {
    return { ...fallback, loadError: errorMessage(error) };
  }
}
