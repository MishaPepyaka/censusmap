import test from "node:test";
import assert from "node:assert/strict";
import { assertDwellingNoUnique, inferRegionFeatureType, summarizeRegion } from "../../src/services/region-service.js";

const dwelling = (id, no) => ({ id, properties: { cu: "12340001", dwellingNo: no }, geometry: { type: "Point", coordinates: [-97, 56] } });

test("region service rejects duplicate dwelling identities", () => {
  assert.throws(() => assertDwellingNoUnique(dwelling(2, "0001"), [dwelling(1, "0001")]), /already exists/);
  assert.doesNotThrow(() => assertDwellingNoUnique(dwelling(1, "0001"), [dwelling(1, "0001")], 1));
});

test("region service classifies and summarizes region data", () => {
  assert.equal(inferRegionFeatureType({ properties: { _group: "cu" }, geometry: { type: "Polygon", coordinates: [] } }), "cu");
  const summary = summarizeRegion({ cld: "1234", ssids: ["A"], cuCodes: ["12340001"] }, { cu: [{}], blocks: [{}], dwellings: [dwelling(1, "0001"), { properties: { _group: "special_locations" }, geometry: { type: "Point", coordinates: [-97, 56] } }] });
  assert.deepEqual(summary.counts, { cu: 1, blocks: 1, dwellings: 1, specialLocations: 1 });
});
