import test from "node:test";
import assert from "node:assert/strict";
import { createPostgisRegionRepository } from "../../src/repositories/postgis-region-repository.js";

test("PostGIS region repository maps index and GeoJSON feature rows", async () => {
  const calls = [];
  const transactionCalls = [];
  let released = false;
  let revision = 1;
  const client = {
    query: async (query, values) => {
      transactionCalls.push({ query, values });
      if (query.includes("UPDATE cld_regions") && query.includes("RETURNING revision")) {
        if (values[1] !== null && values[1] !== revision) return { rows: [] };
        revision += 1;
        return { rows: [{ revision }] };
      }
      if (query.includes("SELECT revision")) return { rows: [{ revision }] };
      if (query.includes("RETURNING id")) return { rows: [{ id: 7 }] };
      if (query.includes("UPDATE region_features") || query.includes("DELETE FROM region_features")) return { rows: [], rowCount: 1 };
      return { rows: [] };
    },
    release: () => { released = true; }
  };
  const pool = { query: async (query, values) => {
    calls.push({ query, values });
    if (query.includes("SELECT cld")) return { rows: [{ cld: "1234", label: "Test", ssids: ["A"], cu_codes: ["12340001"], created_at: "a", updated_at: "b" }] };
    if (query.includes("SELECT id, feature_type")) return { rows: [{ id: 8, feature_type: "dwellings", properties: { DWELLING_NO: "12" }, geometry: { type: "Point", coordinates: [-97, 56] } }] };
    if (query.includes("SELECT DISTINCT")) return { rows: [{ cu_code: "12340009" }] };
    return { rows: [{ id: 7, properties: { CUID: "12340001" }, geometry: { type: "Point", coordinates: [-97, 56] } }] };
  }, connect: async () => client };
  const repository = createPostgisRegionRepository(pool);
  assert.deepEqual(await repository.readIndex("1234"), { cld: "1234", label: "Test", ssids: ["A"], cuCodes: ["12340001"], revision: 1, createdAt: "a", updatedAt: "b" });
  const features = await repository.readFeatures("1234", "dwellings");
  assert.equal(features[0].properties.cu, "12340001");
  assert.deepEqual(calls[1].values, ["1234", "dwellings"]);
  await repository.writeIndex("1234", { label: "Updated", ssids: ["B"], cuCodes: ["12340002"] });
  assert.deepEqual(calls[2].values, ["1234", "Updated", ["B"], ["12340002"]]);
  assert.match(calls[2].query, /UPDATE cld_regions/);
  const found = await repository.findFeature("1234", 8);
  assert.equal(found.type, "dwellings");
  assert.equal(found.feature.properties.dwellingNo, "0012");
  assert.deepEqual(calls[3].values, ["1234", 8]);
  assert.equal(await repository.createFeature("1234", "dwellings", { properties: { CUID: "12340001", DWELLING_NO: "12" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 1), 7);
  const created = transactionCalls.find((call) => call.query.includes("RETURNING id"));
  assert.deepEqual(created.values, ["1234", "dwellings", JSON.stringify({ CUID: "12340001", DWELLING_NO: "12", cu: "12340001", dwellingNo: "0012" }), JSON.stringify({ type: "Point", coordinates: [-97, 56] })]);
  await assert.rejects(
    () => repository.updateFeature("1234", 7, { properties: { CUID: "12340001", DWELLING_NO: "13" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 1),
    { name: "RegionRevisionConflictError", actualRevision: 2 }
  );
  assert.equal(await repository.updateFeature("1234", 7, { properties: { CUID: "12340001", DWELLING_NO: "13" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 2), true);
  const updated = transactionCalls.find((call) => call.query.includes("UPDATE region_features"));
  assert.deepEqual(updated.values, [7, "1234", JSON.stringify({ CUID: "12340001", DWELLING_NO: "13", cu: "12340001", dwellingNo: "0013" }), JSON.stringify({ type: "Point", coordinates: [-97, 56] })]);
  assert.equal(await repository.deleteFeature("1234", 7, 3), true);
  const deleted = transactionCalls.find((call) => call.query.includes("DELETE FROM region_features") && call.values?.[1] !== "cu");
  assert.deepEqual(deleted.values, [7, "1234"]);
  assert.equal(revision, 4);
  const bulkStart = transactionCalls.length;
  await repository.writeFeatures("1234", "cu", [{ id: 8, properties: { CUID: "12340002" }, geometry: { type: "Polygon", coordinates: [] } }]);
  const bulkCalls = transactionCalls.slice(bulkStart);
  assert.equal(bulkCalls[0].query, "BEGIN");
  assert.deepEqual(bulkCalls[1].values, ["1234", "cu"]);
  assert.deepEqual(bulkCalls[2].values.slice(0, 3), [8, "1234", "cu"]);
  assert.deepEqual(bulkCalls[3].values, ["1234", ["12340002"]]);
  assert.equal(bulkCalls[4].query, "COMMIT");
  assert.equal(released, true);
  const bundle = await repository.readBundle("1234");
  assert.equal(bundle.index.cld, "1234");
  assert.equal(bundle.cu.length, 1);
  assert.equal(bundle.blocks.length, 1);
  assert.equal(bundle.dwellings.length, 1);
  await repository.syncCuCodes("1234");
  assert.deepEqual(calls.at(-2).values, ["1234"]);
  assert.deepEqual(calls.at(-1).values, ["1234", ["12340009"]]);
  await repository.ensureRegion("1234", "Updated");
  assert.deepEqual(calls.at(-1).values, ["1234", "Updated"]);
  assert.match(calls.at(-1).query, /INSERT INTO cld_regions/);
  assert.deepEqual((await repository.listIndexes()).map((index) => index.cld), ["1234"]);
  assert.deepEqual(await repository.resolveLookup("1234"), { cld: "1234", matchedBy: "cld", label: "Test" });
});
