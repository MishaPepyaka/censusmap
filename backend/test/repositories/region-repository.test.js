import test from "node:test";
import assert from "node:assert/strict";
import { createRegionRepository, createRegionStorageAdapter } from "../../src/repositories/region-repository.js";

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

test("region storage adapter normalizes file-store operations", async () => {
  const calls = [];
  const fileRepository = {
    async createFeature(...args) { calls.push(["create", ...args]); return 7; },
    async deleteFeature(...args) { calls.push(["delete", ...args]); return true; },
    async ensureMediaDirs(...args) { calls.push(["media", ...args]); },
    async ensureRegion(...args) { calls.push(["ensure", ...args]); },
    async exists() { return true; },
    async findFeature() { return null; },
    async listIndexes() { return []; },
    async readBundle() { return { index: { cld: "1234" } }; },
    async readFeatures() { return []; },
    async resolveLookup() { return null; },
    async updateFeature(...args) { calls.push(["update", ...args]); return true; }
  };
  const storage = createRegionStorageAdapter({ fileRepository, useFileStore: true });

  assert.equal(await storage.createFeature("1234", "dwellings", {}, 2), 7);
  assert.equal(await storage.updateFeature("1234", "dwellings", 7, {}, 2), true);
  assert.equal(await storage.deleteFeature("1234", "dwellings", 7, 2), true);
  await storage.ensureMediaDirs("1234");
  assert.deepEqual(await storage.readBundle("1234"), { index: { cld: "1234" } });
  assert.deepEqual(calls, [
    ["create", "1234", "dwellings", {}, 2],
    ["update", "1234", "dwellings", 7, {}, 2],
    ["delete", "1234", "dwellings", 7, 2],
    ["media", "1234"],
    ["ensure", "1234"]
  ]);
});

test("region storage adapter hides PostGIS feature type from persistence calls", async () => {
  const calls = [];
  const postgisRepository = {
    async createFeature(...args) { calls.push(["create", ...args]); return 7; },
    async deleteFeature(...args) { calls.push(["delete", ...args]); return true; },
    async exists() { return true; },
    async findFeature() { return null; },
    async listIndexes() { return []; },
    async readBundle() { return {}; },
    async readFeatures() { return []; },
    async resolveLookup() { return null; },
    async syncCuCodes(...args) { calls.push(["sync", ...args]); },
    async updateFeature(...args) { calls.push(["update", ...args]); return true; }
  };
  const storage = createRegionStorageAdapter({
    postgisRepository,
    ensurePostgisMediaDirs: async (cld) => calls.push(["media", cld]),
    useFileStore: false
  });

  await storage.updateFeature("1234", "dwellings", 7, {}, 2);
  await storage.deleteFeature("1234", "dwellings", 7, 2);
  await storage.ensureMediaDirs("1234");
  await storage.syncCuCodes("1234");
  assert.deepEqual(calls, [
    ["update", "1234", 7, {}, 2],
    ["delete", "1234", 7, 2],
    ["media", "1234"],
    ["sync", "1234"]
  ]);
});
