import test from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { registerRegionRoutes } from "../../src/routes/region-routes.js";
import { RegionRevisionConflictError } from "../../src/domain/region-revision.js";
import { buildFeatureCollection, extractCuCode, normalizeClD, normalizeDwellingNo, normalizeFeatures } from "../../src/domain/region-feature.js";
import { summarizeRegion } from "../../src/services/region-service.js";

test("region feature mutations require a current revision and report conflicts", async (t) => {
  const app = express();
  app.use(express.json());
  let revision = 1;
  const expectedRevisions = [];
  const bundle = () => ({ index: { cld: "1234", revision }, cu: [], blocks: [], dwellings: [] });
  registerRegionRoutes(app, {
    buildFeatureCollection,
    extractCuCode,
    normalizeClD,
    normalizeDwellingNo,
    normalizeFeatures,
    pool: null,
    requireAuth: (_req, _res, next) => next(),
    requireClDAccess: (_req, _res, next) => next(),
    summarizeRegion,
    useFileStore: true,
    repository: {
      async createFeature(_cld, _feature, expectedRevision) {
        expectedRevisions.push(expectedRevision);
        if (expectedRevision !== revision) throw new RegionRevisionConflictError(revision);
        revision += 1;
        return 7;
      },
      async deleteFeature() { return true; },
      async createImageUpload() { return {}; },
      async ensureMediaDirs() {},
      async exists() { return true; },
      async readBundle() { return bundle(); },
      async updateFeature() { return true; }
    }
  });
  const server = await new Promise((resolve) => {
    const listener = app.listen(0, () => resolve(listener));
  });
  t.after(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const feature = {
    type: "Feature",
    properties: { CLD: "1234", CUID: "12340001", DWELLING_NO: "1" },
    geometry: { type: "Point", coordinates: [-97, 56] }
  };

  const snapshot = await fetch(`${baseUrl}/api/cld/1234/features`);
  assert.equal(snapshot.status, 200);
  assert.equal(snapshot.headers.get("etag"), "\"1\"");
  assert.deepEqual(await snapshot.json(), { type: "FeatureCollection", features: [], revision: 1 });

  const missing = await fetch(`${baseUrl}/api/cld/1234/features`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feature)
  });
  assert.equal(missing.status, 428);

  const missingUpdate = await fetch(`${baseUrl}/api/cld/1234/features/7`, {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(feature)
  });
  assert.equal(missingUpdate.status, 428);

  const missingDelete = await fetch(`${baseUrl}/api/cld/1234/features/7`, { method: "DELETE" });
  assert.equal(missingDelete.status, 428);

  const created = await fetch(`${baseUrl}/api/cld/1234/features`, {
    method: "POST", headers: { "Content-Type": "application/json", "If-Match": "\"1\"" }, body: JSON.stringify(feature)
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("etag"), "\"2\"");
  assert.deepEqual(await created.json(), { ok: true, inserted: 1, ids: [7], revision: 2 });
  assert.deepEqual(expectedRevisions, [1]);

  const stale = await fetch(`${baseUrl}/api/cld/1234/features`, {
    method: "POST", headers: { "Content-Type": "application/json", "If-Match": "1" }, body: JSON.stringify(feature)
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.headers.get("etag"), "\"2\"");
  assert.deepEqual(await stale.json(), {
    error: "Region has changed; reload the latest snapshot before saving", revision: 2
  });
});
