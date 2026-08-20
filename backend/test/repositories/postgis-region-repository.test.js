import test from "node:test";
import assert from "node:assert/strict";
import { createPostgisRegionRepository } from "../../src/repositories/postgis-region-repository.js";

test("PostGIS region repository maps index and GeoJSON feature rows", async () => {
  const calls = [];
  const transactionCalls = [];
  let released = false;
  const client = {
    query: async (query, values) => transactionCalls.push({ query, values }),
    release: () => { released = true; }
  };
  const pool = { query: async (query, values) => {
    calls.push({ query, values });
    if (query.includes("SELECT cld")) return { rows: [{ cld: "1234", label: "Test", ssids: ["A"], cu_codes: ["12340001"], created_at: "a", updated_at: "b" }] };
    if (query.includes("SELECT id, feature_type")) return { rows: [{ id: 8, feature_type: "dwellings", properties: { DWELLING_NO: "12" }, geometry: { type: "Point", coordinates: [-97, 56] } }] };
    return { rows: [{ id: 7, properties: { CUID: "12340001" }, geometry: { type: "Point", coordinates: [-97, 56] } }] };
  }, connect: async () => client };
  const repository = createPostgisRegionRepository(pool);
  assert.deepEqual(await repository.readIndex("1234"), { cld: "1234", label: "Test", ssids: ["A"], cuCodes: ["12340001"], createdAt: "a", updatedAt: "b" });
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
  assert.equal(await repository.createFeature("1234", "dwellings", { properties: { CUID: "12340001", DWELLING_NO: "12" }, geometry: { type: "Point", coordinates: [-97, 56] } }), 7);
  assert.deepEqual(calls[4].values, ["1234", "dwellings", JSON.stringify({ CUID: "12340001", DWELLING_NO: "12", cu: "12340001", dwellingNo: "0012" }), JSON.stringify({ type: "Point", coordinates: [-97, 56] })]);
  await repository.updateFeature("1234", 7, { properties: { CUID: "12340001", DWELLING_NO: "13" }, geometry: { type: "Point", coordinates: [-97, 56] } });
  assert.deepEqual(calls[5].values, [7, "1234", JSON.stringify({ CUID: "12340001", DWELLING_NO: "13", cu: "12340001", dwellingNo: "0013" }), JSON.stringify({ type: "Point", coordinates: [-97, 56] })]);
  assert.match(calls[5].query, /UPDATE region_features/);
  await repository.deleteFeature("1234", 7);
  assert.deepEqual(calls[6].values, [7, "1234"]);
  assert.match(calls[6].query, /DELETE FROM region_features/);
  await repository.writeFeatures("1234", "cu", [{ id: 8, properties: { CUID: "12340002" }, geometry: { type: "Polygon", coordinates: [] } }]);
  assert.equal(transactionCalls[0].query, "BEGIN");
  assert.deepEqual(transactionCalls[1].values, ["1234", "cu"]);
  assert.deepEqual(transactionCalls[2].values.slice(0, 3), [8, "1234", "cu"]);
  assert.deepEqual(transactionCalls[3].values, ["1234", ["12340002"]]);
  assert.equal(transactionCalls[4].query, "COMMIT");
  assert.equal(released, true);
});
