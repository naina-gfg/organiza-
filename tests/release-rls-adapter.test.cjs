'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createPostgresAdapter } = require('../backend/db/postgres-adapter');

class TestPool extends EventEmitter {
  constructor() {
    super();
    this.clients = [];
    this.failRollback = false;
  }
  async connect() {
    const pool = this;
    const client = {
      calls: [],
      discarded: false,
      async query(sql, args) {
        this.calls.push({ sql, args });
        if (sql.startsWith('SELECT set_config')) await new Promise(resolve => setTimeout(resolve, 5));
        if (sql === 'SELECT falhar') throw new Error('falha simulada');
        if (sql === 'ROLLBACK' && pool.failRollback) throw new Error('rollback indisponivel');
        return { rows: [], rowCount: 0 };
      },
      release(discard) { this.discarded = discard; }
    };
    this.clients.push(client);
    return client;
  }
  async end() {}
}

test('adaptador separa identidades concorrentes e zera os demais contextos', async () => {
  const db = createPostgresAdapter({ poolConfig: {} }, TestPool);
  try {
    await Promise.all([
      db.withUserContext(11, () => db.query('SELECT 1')),
      db.withUserContext(22, () => db.query('SELECT 2')),
      db.query('SELECT 3')
    ]);
    const values = db.pool.clients.map(client => client.calls[1].args);
    assert.deepEqual(values, [['11', '', '', ''], ['22', '', '', ''], ['', '', '', '']]);
    for (const client of db.pool.clients) {
      assert.equal(client.calls[0].sql, 'BEGIN');
      assert.equal(client.calls.at(-1).sql, 'COMMIT');
      assert.equal(client.discarded, false);
    }
    assert.throws(() => db.withUserContext(0, () => {}), /Identidade/);
  } finally {
    await db.close();
  }
});

test('adaptador reverte falhas e descarta conexão quando rollback falha', async () => {
  const db = createPostgresAdapter({ poolConfig: {} }, TestPool);
  try {
    await assert.rejects(() => db.withUserContext(11, () => db.query('SELECT falhar')), /falha simulada/);
    assert.equal(db.pool.clients[0].calls.at(-1).sql, 'ROLLBACK');
    assert.equal(db.pool.clients[0].discarded, false);
    db.pool.failRollback = true;
    await assert.rejects(() => db.withUserContext(22, () => db.query('SELECT falhar')), /falha simulada/);
    assert.equal(db.pool.clients[1].calls.at(-1).sql, 'ROLLBACK');
    assert.equal(db.pool.clients[1].discarded, true);
  } finally {
    await db.close();
  }
});
