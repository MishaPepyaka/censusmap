import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createFileRegionRepository } from "../../src/repositories/file-region-repository.js";

test("file region repository reads and normalizes a region bundle", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "censusmap-region-repository-"));
  const regionDir = path.join(rootDir, "1234");
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  await fs.mkdir(regionDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(regionDir, "index.json"), JSON.stringify({ cld: "1234", label: "Test" })),
    fs.writeFile(path.join(regionDir, "cu.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{ id: "7", properties: { CUID: "12340001" }, geometry: { type: "Polygon", coordinates: [] } }] })),
    fs.writeFile(path.join(regionDir, "blocks.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] })),
    fs.writeFile(path.join(regionDir, "dwellings.geojson"), JSON.stringify({ type: "FeatureCollection", features: [] }))
  ]);

  const repository = createFileRegionRepository(rootDir);
  assert.equal(await repository.exists("1234"), true);
  assert.equal(await repository.exists("9999"), false);
  const bundle = await repository.readBundle("1234");
  assert.deepEqual(bundle.index, { cld: "1234", label: "Test" });
  assert.equal(bundle.cu[0].id, 7);
  assert.equal(bundle.cu[0].properties.cu, "12340001");

  await repository.writeFeatures("1234", "dwellings", [{ id: "8", properties: { CUID: "12340001", DWELLING_NO: "12" }, geometry: { type: "Point", coordinates: [-97, 56] } }]);
  await repository.writeIndex("1234", { label: "Updated", cuCodes: ["12340001"], nextFeatureId: 9 });
  const updatedBundle = await repository.readBundle("1234");
  assert.equal(updatedBundle.index.label, "Updated");
  assert.equal(updatedBundle.index.nextFeatureId, 9);
  assert.equal(updatedBundle.dwellings[0].properties.dwellingNo, "0012");
  assert.equal((await repository.findFeature("1234", 7)).type, "cu");
  assert.equal((await repository.findFeature("1234", 8)).feature.properties.dwellingNo, "0012");

  await repository.ensureRegion("5678");
  assert.equal(await repository.exists("5678"), true);
  const emptyBundle = await repository.readBundle("5678");
  assert.equal(emptyBundle.index.label, "CLD 5678");
  assert.equal(emptyBundle.index.nextFeatureId, 1);
  assert.deepEqual(emptyBundle.cu, []);
  assert.deepEqual(emptyBundle.blocks, []);
  assert.deepEqual(emptyBundle.dwellings, []);
  assert.equal(await fs.stat(path.join(rootDir, "5678", "media", "dwellings")).then((entry) => entry.isDirectory()), true);
  assert.equal(await repository.createFeature("5678", "dwellings", { properties: { CUID: "56780001", DWELLING_NO: "3" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 1), 1);
  assert.equal((await repository.readIndex("5678")).revision, 2);
  assert.equal((await repository.readFeatures("5678", "dwellings"))[0].properties.dwellingNo, "0003");
  await assert.rejects(() => repository.updateFeature("5678", "dwellings", 1, { properties: { CUID: "56780001", DWELLING_NO: "4" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 1), { name: "RegionRevisionConflictError", actualRevision: 2 });
  assert.equal(await repository.updateFeature("5678", "dwellings", 1, { properties: { CUID: "56780001", DWELLING_NO: "4" }, geometry: { type: "Point", coordinates: [-97, 56] } }, 2), true);
  assert.equal((await repository.readIndex("5678")).revision, 3);
  assert.equal((await repository.readFeatures("5678", "dwellings"))[0].properties.dwellingNo, "0004");
  assert.equal(await repository.deleteFeature("5678", "dwellings", 1, 3), true);
  assert.equal((await repository.readIndex("5678")).revision, 4);
  assert.deepEqual(await repository.readFeatures("5678", "dwellings"), []);
  assert.deepEqual((await repository.listIndexes()).map((index) => index.cld), ["1234", "5678"]);
  assert.deepEqual(await repository.resolveLookup("12340001"), { cld: "1234", matchedBy: "cu", label: "Updated" });
});

test("file region repository serializes concurrent writes for one CLD", async (t) => {
  const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "censusmap-region-repository-"));
  t.after(() => fs.rm(rootDir, { recursive: true, force: true }));
  const repository = createFileRegionRepository(rootDir);
  await repository.ensureRegion("5678");
  const feature = (dwellingNo) => ({
    properties: { CUID: "56780001", DWELLING_NO: dwellingNo },
    geometry: { type: "Point", coordinates: [-97, 56] }
  });

  const results = await Promise.allSettled([
    repository.createFeature("5678", "dwellings", feature("1"), 1),
    repository.createFeature("5678", "dwellings", feature("2"), 1)
  ]);

  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  const rejected = results.find((result) => result.status === "rejected");
  assert.equal(rejected.reason.name, "RegionRevisionConflictError");
  assert.equal(rejected.reason.actualRevision, 2);
  assert.equal((await repository.readIndex("5678")).revision, 2);
  assert.equal((await repository.readFeatures("5678", "dwellings")).length, 1);
});
