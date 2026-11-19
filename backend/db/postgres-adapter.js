'use strict';

const { Pool } = require('pg');
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

  pool.on('error', (err) => {
    console.error('[db:postgres] Erro em cliente ocioso do pool:', sanitizeErrorMessage(err));
  });

  async function executeQuery(sql, args, { forRun = false } = {}) {
    const translated = translateSqlToPostgres(sql, { forRun });
    // Executa sem nome de prepared statement para manter compatibilidade com Supabase Transaction Pooler
    const result = await pool.query(translated.text, args);
    return { translated, result };
  }

  const adapter = {
    dialect: 'postgres',
    safeTarget: postgresConfig.safeTarget,
    pool,

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
