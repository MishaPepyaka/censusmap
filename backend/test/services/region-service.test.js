import test from "node:test";
import assert from "node:assert/strict";
import { assertDwellingNoUnique, createRegionMutationService, inferRegionFeatureType, summarizeRegion } from "../../src/services/region-service.js";

const dwelling = (id, no) => ({ id, properties: { cu: "12340001", dwellingNo: no }, geometry: { type: "Point", coordinates: [-97, 56] } });

test("region service rejects duplicate dwelling identities", () => {
  assert.throws(() => assertDwellingNoUnique(dwelling(2, "0001"), [dwelling(1, "0001")]), /already exists/);
  assert.doesNotThrow(() => assertDwellingNoUnique(dwelling(1, "0001"), [dwelling(1, "0001")], 1));
});

test("region service classifies and summarizes region data", () => {
  assert.equal(inferRegionFeatureType({ properties: { _group: "cu" }, geometry: { type: "Polygon", coordinates: [] } }), "cu");
  const summary = summarizeRegion({ cld: "1234", revision: 4, ssids: ["A"], cuCodes: ["12340001"] }, { cu: [{}], blocks: [{}], dwellings: [dwelling(1, "0001"), { properties: { _group: "special_locations" }, geometry: { type: "Point", coordinates: [-97, 56] } }] });
  assert.deepEqual(summary.counts, { cu: 1, blocks: 1, dwellings: 1, specialLocations: 1 });
  assert.equal(summary.revision, 4);
});

test("region mutation service validates mutations before calling storage", async () => {
  const calls = [];
  const storage = {
    async createFeature(cld, type, feature, revision) {
      calls.push({ operation: "create", cld, type, feature, revision });
      return 7;
    },
    async deleteFeature(cld, type, id, revision) {
      calls.push({ operation: "delete", cld, type, id, revision });
      return true;
    },
    async exists() { return true; },
    async findFeature() { return { type: "dwellings", feature: dwelling(7, "0002") }; },
    async readFeatures() { return [dwelling(1, "0001")]; },
    async updateFeature(cld, type, id, feature, revision) {
      calls.push({ operation: "update", cld, type, id, feature, revision });
      return true;
    }
  };
  const mutations = createRegionMutationService(storage);
  const feature = { properties: { CLD: "1234", CUID: "12340001", DWELLING_NO: "2" }, geometry: { type: "Point", coordinates: [-97, 56] } };

  assert.equal(await mutations.createFeature("1234", feature, 4), 7);
  assert.equal(await mutations.updateFeature("1234", 7, feature, 5), true);
  assert.equal(await mutations.deleteFeature("1234", 7, 6), true);
  assert.deepEqual(calls.map(({ operation, cld, type, id, revision }) => ({ operation, cld, type, id, revision })), [
    { operation: "create", cld: "1234", type: "dwellings", id: undefined, revision: 4 },
    { operation: "update", cld: "1234", type: "dwellings", id: 7, revision: 5 },
    { operation: "delete", cld: "1234", type: "dwellings", id: 7, revision: 6 }
  ]);
  assert.equal(calls[0].feature.properties.dwellingNo, "0002");
});
