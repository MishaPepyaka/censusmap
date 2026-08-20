import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

const execFileAsync = promisify(execFile);

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "censusmap-api-test-"));
process.env.DATA_DIR = dataDir;
process.env.USE_FILE_STORE = "true";
process.env.NODE_ENV = "test";

const { startServer } = await import("../../src/server.js");

const legacyFeatureStore = {
  nextId: 2,
  features: [{
    id: 1,
    type: "Feature",
    properties: { CLD: "1234", CUID: "12340001", _group: "cu" },
    geometry: {
      type: "Polygon",
      coordinates: [[[-97, 56], [-96.9, 56], [-96.9, 56.1], [-97, 56.1], [-97, 56]]]
    }
  }]
};

await fs.writeFile(path.join(dataDir, "file-store.json"), JSON.stringify(legacyFeatureStore));
const server = await startServer({ listenPort: 0 });
const baseUrl = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await fs.rm(dataDir, { recursive: true, force: true });
});

test("health reports file-store compatibility mode", async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, mode: "file" });
});

test("lookup resolves a migrated CLD and protected region API rejects anonymous access", async () => {
  const lookupResponse = await fetch(`${baseUrl}/api/lookup?q=1234`);
  assert.equal(lookupResponse.status, 200);
  assert.deepEqual(await lookupResponse.json(), {
    cld: "1234",
    matchedBy: "cld",
    label: "CLD 1234"
  });

  const regionResponse = await fetch(`${baseUrl}/api/cld/1234/features`, {
    headers: { accept: "application/json" }
  });
  assert.equal(regionResponse.status, 401);
  assert.deepEqual(await regionResponse.json(), { error: "Authentication required" });
});

test("browser smoke test serves login and redirects anonymous viewer/editor routes", async (t) => {
  const chromium = process.env.CHROMIUM_BIN || "/usr/bin/chromium";
  try {
    await fs.access(chromium);
  } catch {
    t.skip("Chromium is not installed; set CHROMIUM_BIN to enable browser smoke tests");
    return;
  }

  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), "censusmap-browser-test-"));
  t.after(() => fs.rm(profileDir, { recursive: true, force: true }));
  const dumpDom = async (route) => {
    const { stdout } = await execFileAsync(chromium, [
      "--headless",
      "--no-sandbox",
      "--disable-gpu",
      `--user-data-dir=${profileDir}`,
      "--dump-dom",
      `${baseUrl}${route}`
    ], { maxBuffer: 1024 * 1024 });
    return stdout;
  };

  for (const route of ["/login", "/1234", "/1234/edit"]) {
    const html = await dumpDom(route);
    assert.match(html, /<title>Login - Census Map<\/title>/);
    assert.match(html, /<h1 class="landing-title">Login<\/h1>/);
  }
});
