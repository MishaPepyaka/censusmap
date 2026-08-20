import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyFeature,
  assertValidRegionFeature,
  extractClDFromProperties,
  getDwellingIdentity,
  normalizeClD,
  normalizeDwellingProperties,
  normalizeDwellingNo,
  normalizeDwellingStatus,
  normalizeFeatures,
  normalizeSsid
} from "../../src/domain/region-feature.js";

test("normalises CLD, SSID, and dwelling identifiers", () => {
  assert.equal(normalizeClD("CLD 30-38"), "3038");
  assert.equal(normalizeSsid("  ab-123 "), "AB-123");
  assert.equal(normalizeDwellingNo("VR-21"), "0021");
  assert.equal(normalizeDwellingNo("no number"), null);
  assert.equal(normalizeDwellingStatus("500"), "500");
  assert.equal(normalizeDwellingStatus("unknown"), "429");
});

test("adds canonical dwelling fields without dropping legacy input", () => {
  const properties = normalizeDwellingProperties({
    CUID: "12340001",
    CB_COLCODE: "2",
    VR_NUMBER: "7",
    status: "bad-value",
    _group: "dwelling"
  });
  assert.deepEqual(properties, {
    CUID: "12340001",
    CB_COLCODE: "2",
    VR_NUMBER: "7",
    status: "429",
    _group: "dwellings",
    cu: "12340001",
    block: "02",
    dwellingNo: "0007"
  });
  assert.deepEqual(getDwellingIdentity(properties), { cuCode: "12340001", dwellingNo: "0007" });
});

test("resolves a CLD from direct and zone properties", () => {
  assert.equal(extractClDFromProperties({ CFOP_CLD_ID: "3038" }), "3038");
  assert.equal(extractClDFromProperties({ CFOP_ZONE_ID: "30381234" }), "3038");
  assert.equal(extractClDFromProperties({}), "");
});

test("classifies canonical and legacy region features", () => {
  assert.equal(classifyFeature({ geometry: { type: "Point" }, properties: { dwellingNo: "1" } }), "dwellings");
  assert.equal(classifyFeature({ geometry: { type: "Polygon" }, properties: { _group: "cu" } }), "cu");
  assert.equal(classifyFeature({ geometry: { type: "Polygon" }, properties: { CB_COLCODE: "01" } }), "blocks");
  assert.equal(classifyFeature({ geometry: { type: "LineString" }, properties: {} }), "");
});

test("validates supported GeoJSON coordinates and CLD ownership", () => {
  const feature = {
    type: "Feature",
    properties: { CLD: "1234", CUID: "12340001", _group: "cu" },
    geometry: { type: "Polygon", coordinates: [[[-97, 56], [-96, 56], [-96, 57], [-97, 56]]] }
  };
  assert.equal(assertValidRegionFeature(feature, "1234").properties.cu, "12340001");
  assert.throws(() => assertValidRegionFeature(feature, "9999"), /does not match target CLD/);
  assert.throws(() => assertValidRegionFeature({
    ...feature,
    geometry: { type: "Point", coordinates: [200, 56] }
  }, "1234"), /invalid coordinates/);
});

test("normalises Feature and FeatureCollection payloads", () => {
  const feature = { type: "Feature", id: "12", properties: null, geometry: { type: "Point", coordinates: [0, 0] } };
  assert.deepEqual(normalizeFeatures(feature), [{
    id: 12,
    type: "Feature",
    properties: {},
    geometry: { type: "Point", coordinates: [0, 0] }
  }]);
  assert.equal(normalizeFeatures({ type: "FeatureCollection", features: [feature] }).length, 1);
});
