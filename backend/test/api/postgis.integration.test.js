import test from "node:test";
import assert from "node:assert/strict";
import { Pool } from "pg";
import bcrypt from "bcryptjs";

const connectionString = process.env.POSTGRES_TEST_URL || "";
const databaseName = connectionString ? decodeURIComponent(new URL(connectionString).pathname.slice(1)) : "";
const hasTestDatabase = Boolean(connectionString) && /(?:^|[_-])test(?:$|[_-])/i.test(databaseName);
const skipReason = hasTestDatabase ? false : "Set POSTGRES_TEST_URL to a dedicated database whose name contains 'test' to run PostGIS integration tests";

function configureServerDatabase() {
  const url = new URL(connectionString);
  process.env.USE_FILE_STORE = "false";
  process.env.NODE_ENV = "test";
  process.env.POSTGRES_HOST = url.hostname;
  process.env.POSTGRES_PORT = url.port || "5432";
  process.env.POSTGRES_DB = databaseName;
  process.env.POSTGRES_USER = decodeURIComponent(url.username);
  process.env.POSTGRES_PASSWORD = decodeURIComponent(url.password);
}

async function closeServer(server, stopServer) {
  await stopServer(server);
}

test("PostGIS authenticated CRUD is restricted to the user's CLD access", { skip: skipReason }, async (t) => {
  configureServerDatabase();
  const { startServer, stopServer } = await import("../../src/server.js");
  const database = new Pool({ connectionString });
  const suffix = `${Date.now()}${Math.floor(Math.random() * 1000)}`.slice(-6);
  const allowedCld = `8${suffix.slice(0, 3)}`;
  const deniedCld = `9${suffix.slice(0, 3)}`;
  const username = `postgis-test-${suffix}`;
  const password = "postgis-test-password";
  let server;

  t.after(async () => {
    if (server) await closeServer(server, stopServer);
    await database.query("DELETE FROM users WHERE username = $1;", [username]);
    await database.query("DELETE FROM cld_regions WHERE cld = ANY($1::text[]);", [[allowedCld, deniedCld]]);
    await database.end();
  });

  server = await startServer({ listenPort: 0 });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const passwordHash = await bcrypt.hash(password, 10);
  await database.query(
    "INSERT INTO cld_regions (cld, label) VALUES ($1, $2), ($3, $4);",
    [allowedCld, "Allowed test CLD", deniedCld, "Denied test CLD"]
  );
  const { rows: users } = await database.query(
    "INSERT INTO users (username, password_hash, is_admin, role) VALUES ($1, $2, FALSE, 'enumerator') RETURNING id;",
    [username, passwordHash]
  );
  await database.query("INSERT INTO user_clds (user_id, cld) VALUES ($1, $2);", [users[0].id, allowedCld]);

  const login = await fetch(`${baseUrl}/api/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password })
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie, "login must create a session cookie");
  const request = (url, options = {}) => fetch(`${baseUrl}${url}`, {
    ...options,
    headers: { accept: "application/json", cookie, ...options.headers }
  });

  const deniedRead = await request(`/api/cld/${deniedCld}/features`);
  assert.equal(deniedRead.status, 403);
  assert.deepEqual(await deniedRead.json(), { error: `Access to CLD ${deniedCld} denied` });

  const feature = {
    type: "Feature",
    properties: { CLD: allowedCld, CUID: `${allowedCld}0001`, DWELLING_NO: "1", status: "429" },
    geometry: { type: "Point", coordinates: [-97, 56] }
  };
  const created = await request(`/api/cld/${allowedCld}/features`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(feature)
  });
  assert.equal(created.status, 201);
  const createdBody = await created.json();
  const featureId = createdBody.ids[0];

  const updated = await request(`/api/cld/${allowedCld}/features/${featureId}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...feature, properties: { ...feature.properties, DWELLING_NO: "2", status: "400" } })
  });
  assert.equal(updated.status, 200);

  const features = await request(`/api/cld/${allowedCld}/features`);
  assert.equal(features.status, 200);
  const storedFeature = (await features.json()).features.find((item) => Number(item.id) === Number(featureId));
  assert.equal(storedFeature.properties.dwellingNo, "0002");
  assert.equal(storedFeature.properties.status, "400");

  const deleted = await request(`/api/cld/${allowedCld}/features/${featureId}`, { method: "DELETE" });
  assert.equal(deleted.status, 200);
  const afterDelete = await request(`/api/cld/${allowedCld}/features`);
  assert.equal((await afterDelete.json()).features.some((item) => Number(item.id) === Number(featureId)), false);
});
