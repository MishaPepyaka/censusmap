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
    },
    async listCrewLeaderUsers(userId) {
      const { rows } = await pool.query(
        `
          SELECT u.id, u.username
          FROM user_crew_leaders ucl
          JOIN users u ON u.id = ucl.crew_leader_id
          WHERE ucl.user_id = $1
          ORDER BY u.username;
        `,
        [Number(userId)]
      );
      return rows;
    },
    async listManagedUserIds(userId) {
      const { rows } = await pool.query(
        `
          SELECT DISTINCT u.id
          FROM user_crew_leaders ucl
          JOIN users u ON u.id = ucl.user_id
          WHERE ucl.crew_leader_id = $1
          ORDER BY u.id;
        `,
        [Number(userId)]
      );
      return rows.map((row) => row.id);
    },
    async listAllUserIds() {
      const { rows } = await pool.query("SELECT id FROM users ORDER BY id;");
      return rows.map((row) => row.id);
    },
    async listManagedUserIdsIncludingSelf(userId) {
      const { rows } = await pool.query(
        `
          SELECT DISTINCT user_id AS id
          FROM user_crew_leaders
          WHERE crew_leader_id = $1
          UNION
          SELECT $1::integer AS id
          ORDER BY id;
        `,
        [Number(userId)]
      );
      return rows.map((row) => row.id);
    },
    async hasClDAccess(userId, cld) {
      const { rows } = await pool.query(
        `
          SELECT 1
          FROM (
            SELECT cld FROM user_clds WHERE user_id = $1
            UNION
            SELECT ucl.cld
            FROM user_crew_leaders rel
            JOIN user_clds ucl ON ucl.user_id = rel.crew_leader_id
            WHERE rel.user_id = $1
          ) allowed
          WHERE cld = $2 OR cld = '0000'
          LIMIT 1;
        `,
        [Number(userId), cld]
      );
      return rows.length > 0;
    }
  });
}
