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
});
