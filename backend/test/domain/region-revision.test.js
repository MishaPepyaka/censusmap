import test from "node:test";
import assert from "node:assert/strict";
import { RegionRevisionConflictError, parseRegionRevision } from "../../src/domain/region-revision.js";

test("parses strong and weak ETag region revisions", () => {
  assert.equal(parseRegionRevision("4"), 4);
  assert.equal(parseRegionRevision("\"4\""), 4);
  assert.equal(parseRegionRevision("W/\"4\""), 4);
  assert.equal(parseRegionRevision("0"), null);
  assert.equal(parseRegionRevision("latest"), null);
});

test("revision conflicts retain the current revision", () => {
  const error = new RegionRevisionConflictError(7);
  assert.equal(error.actualRevision, 7);
  assert.match(error.message, /reload/i);
});
