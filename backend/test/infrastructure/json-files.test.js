import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { exists, readJsonFile, writeJsonFile } from "../../src/infrastructure/json-files.js";

test("writes and reads JSON while creating parent directories", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "censusmap-json-test-"));
  const filePath = path.join(directory, "nested", "record.json");
  t.after(() => fs.rm(directory, { recursive: true, force: true }));

  assert.equal(await exists(filePath), false);
  await writeJsonFile(filePath, { cld: "1234", features: [] });
  assert.equal(await exists(filePath), true);
  assert.deepEqual(await readJsonFile(filePath, null), { cld: "1234", features: [] });
  assert.deepEqual(await readJsonFile(path.join(directory, "missing.json"), { missing: true }), { missing: true });
});
