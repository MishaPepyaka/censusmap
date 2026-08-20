export function createUserRepository(pool) {
  if (!pool || typeof pool.query !== "function") throw new TypeError("UserRepository requires a queryable pool");
  return Object.freeze({
    async findById(userId) {
      if (!Number.isFinite(Number(userId))) return null;
      const { rows } = await pool.query(
        "SELECT id, username, password_hash, is_admin, role, created_at FROM users WHERE id = $1 LIMIT 1;",
        [Number(userId)]
      );
      return rows[0] || null;
    },
    async findByUsername(username) {
      const { rows } = await pool.query("SELECT * FROM users WHERE username = $1 LIMIT 1;", [username]);
      return rows[0] || null;
    },
    async listDirectAllowedClds(userId) {
      const { rows } = await pool.query("SELECT cld FROM user_clds WHERE user_id = $1 ORDER BY cld;", [Number(userId)]);
      return rows.map((row) => row.cld);
    },
    async listCrewLeaderIds(userId) {
      const { rows } = await pool.query("SELECT crew_leader_id FROM user_crew_leaders WHERE user_id = $1 ORDER BY crew_leader_id;", [Number(userId)]);
      return rows.map((row) => row.crew_leader_id);
    }
  });
}
