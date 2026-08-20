export class RegionRevisionConflictError extends Error {
  constructor(actualRevision) {
    super("Region has changed; reload the latest snapshot before saving");
    this.name = "RegionRevisionConflictError";
    this.actualRevision = Number.isFinite(Number(actualRevision)) ? Number(actualRevision) : 1;
  }
}

export function parseRegionRevision(value) {
  const normalized = String(value ?? "").trim().replace(/^W\//i, "").replace(/^\"|\"$/g, "");
  const revision = Number(normalized);
  return Number.isSafeInteger(revision) && revision >= 1 ? revision : null;
}
