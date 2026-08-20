import test from "node:test";
import assert from "node:assert/strict";
import { createRegionRepository } from "../../src/repositories/region-repository.js";

const operations = {
  createFeature: async () => 1,
  createImageUpload: async () => ({}),
  deleteFeature: async () => true,
  ensureMediaDirs: async () => {},
  exists: async () => true,
  readBundle: async () => ({}),
  updateFeature: async () => true
};

test("RegionRepository exposes a frozen, complete storage contract", () => {
  const repository = createRegionRepository(operations);
  assert.equal(repository.createFeature, operations.createFeature);
  assert.equal(Object.isFrozen(repository), true);
  assert.throws(() => createRegionRepository({}), /requires createFeature/);
});
