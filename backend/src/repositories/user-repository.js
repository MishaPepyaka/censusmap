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
    }
  });
}
