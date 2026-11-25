'use strict';

const { Pool } = require('pg');
const { AsyncLocalStorage } = require('node:async_hooks');
const { attachDatabasePool } = require('@vercel/functions');
const { sanitizeErrorMessage } = require('./config');
const { translateSqlToPostgres } = require('./sql-compat');

function normalizeArgs(params, cb) {
  if (typeof params === 'function') {
    return { args: [], callback: params };
  }
  return {
    args: Array.isArray(params) ? params : params == null ? [] : [params],
    callback: typeof cb === 'function' ? cb : null
  };
}

function sanitizeDbError(err) {
  if (!err || typeof err !== 'object') {
    return new Error(sanitizeErrorMessage(err));
  }
  const safeMessage = sanitizeErrorMessage(err);
  if (safeMessage !== err.message) {
    try {
      err.message = safeMessage;
    } catch {
      const wrapped = new Error(safeMessage);
      wrapped.code = err.code;
      return wrapped;
    }
  }
  return err;
}

function extractLastId(translated, result) {
  if (!translated.isInsert || !Array.isArray(result.rows) || result.rows.length === 0) {
    return 0;
  }
  const firstRow = result.rows[0];
  if (!firstRow || firstRow.id === undefined || firstRow.id === null) {
    return 0;
  }
  const numericId = Number(firstRow.id);
  return Number.isSafeInteger(numericId) ? numericId : firstRow.id;
}

function createPostgresAdapter(postgresConfig, PoolImpl = Pool) {
  const pool = new PoolImpl(postgresConfig.poolConfig);
  const identity = new AsyncLocalStorage();

  if (
    pool &&
    typeof pool.on === 'function' &&
    pool.options &&
    'idleTimeoutMillis' in pool.options
  ) {
    attachDatabasePool(pool);
  }

  pool.on('error', (err) => {
    console.error('[db:postgres] Erro em cliente ocioso do pool:', sanitizeErrorMessage(err));
  });

  async function executeQuery(sql, args, { forRun = false } = {}) {
    const translated = translateSqlToPostgres(sql, { forRun });
    // Executa sem nome de prepared statement para manter compatibilidade com Supabase Transaction Pooler
    const context = identity.getStore();
    const client = await pool.connect();
    let discard = false;
    let result;
    try {
      await client.query('BEGIN');
      // Zera TODOS os contextos por transacao, inclusive em operacoes anonimas.
      // Isto evita herdar valores de uma conexao previamente contaminada.
      const valueFor = (key) => context && context.key === key ? context.value : '';
      await client.query(
        `SELECT set_config('app.current_user_id', $1, true),
                set_config('app.lookup_email', $2, true),
                set_config('app.session_token_hash', $3, true),
                set_config('app.session_cleanup', $4, true)`,
        [valueFor('app.current_user_id'), valueFor('app.lookup_email'),
          valueFor('app.session_token_hash'), valueFor('app.session_cleanup')]
      );
      result = await client.query(translated.text, args);
      await client.query('COMMIT');
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
      throw error;
    } finally {
      client.release(discard);
    }
    return { translated, result };
  }

  const adapter = {
    dialect: 'postgres',
    safeTarget: postgresConfig.safeTarget,
    pool,

    withUserContext(userId, operation) {
      if (!Number.isSafeInteger(userId) || userId <= 0 || userId > 2147483647) {
        throw new TypeError('Identidade de usuario invalida.');
      }
      if (typeof operation !== 'function') throw new TypeError('Operacao invalida.');
      return identity.run({ key: 'app.current_user_id', value: String(userId) }, operation);
    },

    withEmailContext(email, operation) {
      if (typeof email !== 'string' || !email || email.length > 254 || typeof operation !== 'function') {
        throw new TypeError('Contexto de e-mail invalido.');
      }
      return identity.run({ key: 'app.lookup_email', value: email }, operation);
    },

    withTokenContext(tokenHash, operation) {
      if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash) || typeof operation !== 'function') {
        throw new TypeError('Contexto de sessao invalido.');
      }
      return identity.run({ key: 'app.session_token_hash', value: tokenHash }, operation);
    },

    withSessionCleanup(operation) {
      if (typeof operation !== 'function') throw new TypeError('Operacao invalida.');
      return identity.run({ key: 'app.session_cleanup', value: '1' }, operation);
    },

    async ready() {
      await pool.query('SELECT 1');
    },

    async query(sql, params = []) {
      const args = Array.isArray(params) ? params : params == null ? [] : [params];
      try {
        const { result } = await executeQuery(sql, args, { forRun: false });
        return result;
      } catch (err) {
        throw sanitizeDbError(err);
      }
    },

    get(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      executeQuery(sql, args, { forRun: false }).then(
        ({ result }) => {
          if (callback) callback(null, result.rows[0]);
        },
        (err) => {
          const safeErr = sanitizeDbError(err);
          if (callback) callback(safeErr);
          else console.error('[db:postgres] Erro em db.get:', safeErr.message);
        }
      );
      return adapter;
    },

    all(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      executeQuery(sql, args, { forRun: false }).then(
        ({ result }) => {
          if (callback) callback(null, result.rows);
        },
        (err) => {
          const safeErr = sanitizeDbError(err);
          if (callback) callback(safeErr);
          else console.error('[db:postgres] Erro em db.all:', safeErr.message);
        }
      );
      return adapter;
    },

    run(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      executeQuery(sql, args, { forRun: true }).then(
        ({ translated, result }) => {
          const changes = Number.isFinite(result.rowCount) ? result.rowCount : 0;
          const lastID = extractLastId(translated, result);
          if (callback) {
            callback.call({ lastID, changes }, null);
          }
        },
        (err) => {
          const safeErr = sanitizeDbError(err);
          if (callback) {
            callback.call({ lastID: 0, changes: 0 }, safeErr);
          } else {
            console.error('[db:postgres] Erro em db.run:', safeErr.message);
          }
        }
      );
      return adapter;
    },

    serialize(fn) {
      if (typeof fn === 'function') fn();
      return adapter;
    },

    close(cb) {
      const promise = pool.ending || pool.ended ? Promise.resolve() : pool.end();
      if (typeof cb === 'function') {
        promise.then(() => cb(null), (err) => cb(sanitizeDbError(err)));
        return adapter;
      }
      return promise.catch((err) => {
        throw sanitizeDbError(err);
      });
    }
  };

  return adapter;
}

module.exports = {
  createPostgresAdapter
};
