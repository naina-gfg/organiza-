'use strict';

// Prototipo isolado: nunca usar pool.query entre BEGIN, set_config e COMMIT.
async function withUserTransaction(pool, userId, operation) {
  if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647) {
    throw new TypeError('Identidade de usuario invalida.');
  }
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userId)]);
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { destroy = true; }
    throw error;
  } finally {
    client.release(destroy);
  }
}

module.exports = { withUserTransaction };
