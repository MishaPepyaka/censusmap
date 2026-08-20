import test from "node:test";
import assert from "node:assert/strict";
import { createUserRepository } from "../../src/repositories/user-repository.js";

test("user repository loads users by id and username", async () => {
  const calls = [];
  const repository = createUserRepository({ query: async (sql, values) => {
    calls.push({ sql, values });
    if (sql.includes("FROM user_clds")) return { rows: [{ cld: "1234" }] };
    if (sql.includes("JOIN users u ON u.id = ucl.crew_leader_id")) return { rows: [{ id: 9, username: "leader" }] };
    if (sql.includes("JOIN users u ON u.id = ucl.user_id")) return { rows: [{ id: 8 }] };
    if (sql.includes("SELECT DISTINCT user_id AS id")) return { rows: [{ id: 7 }, { id: 8 }] };
    if (sql.includes("SELECT id FROM users ORDER BY id")) return { rows: [{ id: 7 }, { id: 8 }] };
    if (sql.includes("SELECT 1")) return { rows: [{ "?column?": 1 }] };
    if (sql.includes("FROM user_crew_leaders")) return { rows: [{ crew_leader_id: 9 }] };
    return { rows: values?.[0] === "missing" ? [] : [{ id: 7, username: "editor" }] };
  } });
  assert.deepEqual(await repository.findById(7), { id: 7, username: "editor" });
  assert.equal(await repository.findById("bad"), null);
  assert.deepEqual(await repository.findByUsername("editor"), { id: 7, username: "editor" });
  assert.equal(await repository.findByUsername("missing"), null);
  assert.deepEqual(await repository.listUsers(), [{ id: 7, username: "editor" }]);
  assert.equal(await repository.create({ username: "new", passwordHash: "hash", isAdmin: false, role: "enumerator" }), 7);
  await repository.updatePassword(7, "new-hash");
  await repository.updateRole(7, "crew_leader");
  await repository.replaceDirectAllowedClds(7, ["1234"]);
  await repository.replaceCrewLeaderIds(7, [9]);
  await repository.addCrewLeader(7, 9);
  await repository.delete(7);
  assert.deepEqual(await repository.listDirectAllowedClds(7), ["1234"]);
  assert.deepEqual(await repository.listCrewLeaderIds(7), [9]);
  assert.deepEqual(await repository.listCrewLeaderUsers(7), [{ id: 9, username: "leader" }]);
  assert.deepEqual(await repository.listManagedUserIds(9), [8]);
  assert.deepEqual(await repository.listAllUserIds(), [7, 8]);
  assert.deepEqual(await repository.listManagedUserIdsIncludingSelf(9), [7, 8]);
  assert.equal(await repository.hasClDAccess(7, "1234"), true);
  assert.equal(calls.length, 20);
});
