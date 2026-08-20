import test from "node:test";
import assert from "node:assert/strict";
import { createErrorHandler } from "../src/app.js";

function createResponse() {
  return {
    headersSent: false,
    statusCode: null,
    contentType: null,
    payload: null,
    status(code) { this.statusCode = code; return this; },
    type(value) { this.contentType = value; return this; },
    json(value) { this.payload = value; return this; },
    send(value) { this.payload = value; return this; }
  };
}

test("central error handler returns a safe API response", () => {
  const messages = [];
  const response = createResponse();
  createErrorHandler({ logger: (...args) => messages.push(args) })(new Error("database password"), { path: "/api/cld/1234" }, response, () => {});
  assert.equal(response.statusCode, 500);
  assert.deepEqual(response.payload, { error: "Internal server error" });
  assert.equal(messages.length, 1);
});

test("central error handler sends a text response for page routes", () => {
  const response = createResponse();
  createErrorHandler({ logger: () => {} })(new Error("boom"), { path: "/1234" }, response, () => {});
  assert.equal(response.statusCode, 500);
  assert.equal(response.contentType, "text");
  assert.equal(response.payload, "Internal server error");
});
