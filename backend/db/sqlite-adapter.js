'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { sanitizeErrorMessage } = require('./config');

const SQLITE_MIGRATIONS_DIR = path.resolve(__dirname, '..', '..', 'migrations', 'sqlite');

function readSqliteMigration(filename) {
  return fs.readFileSync(path.join(SQLITE_MIGRATIONS_DIR, filename), 'utf8');
}

function normalizeArgs(params, cb) {
  if (typeof params === 'function') {
    return { args: [], callback: params };
  }
  return {
    args: Array.isArray(params) ? params : params == null ? [] : [params],
    callback: typeof cb === 'function' ? cb : null
  };
}

function runRaw(rawDb, sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function execRaw(rawDb, sql) {
  return new Promise((resolve, reject) => {
    rawDb.exec(sql, (err) => {
      if (err) return reject(err);
      resolve();
    });
  });
}

function allRaw(rawDb, sql, params = []) {
  return new Promise((resolve, reject) => {
    rawDb.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

async function initializeSqliteSchema(rawDb) {
  const migration001 = readSqliteMigration('001_initial_schema.sql');
  const migration002 = readSqliteMigration('002_sessions_and_rate_limits.sql');

  await runRaw(rawDb, 'PRAGMA busy_timeout = 5000');
  await execRaw(rawDb, migration001);

  // Atualiza bancos SQLite legados que ainda nao possuam ON DELETE SET NULL em tasks.discipline_id
  const fkList = await allRaw(rawDb, "PRAGMA foreign_key_list('tasks')");
  const disciplineFk = fkList.find(fk => fk.from === 'discipline_id');
  if (!disciplineFk || String(disciplineFk.on_delete).toUpperCase() !== 'SET NULL') {
    await runRaw(rawDb, 'PRAGMA foreign_keys = OFF');
    await runRaw(rawDb, 'BEGIN IMMEDIATE');
    try {
      await runRaw(
        rawDb,
        `CREATE TABLE tasks_migrated (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          discipline_id INTEGER,
          title TEXT NOT NULL,
          description TEXT,
          due_date TEXT,
          priority TEXT DEFAULT 'Média',
          status TEXT DEFAULT 'Pendente',
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
          FOREIGN KEY(discipline_id) REFERENCES disciplines(id) ON DELETE SET NULL
        )`
      );
      await runRaw(
        rawDb,
        `INSERT INTO tasks_migrated
          (id, user_id, discipline_id, title, description, due_date, priority, status, created_at)
         SELECT
           t.id,
           t.user_id,
           CASE
             WHEN t.discipline_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM disciplines d WHERE d.id = t.discipline_id AND d.user_id = t.user_id
             ) THEN t.discipline_id
             ELSE NULL
           END,
           t.title,
           t.description,
           t.due_date,
           t.priority,
           t.status,
           t.created_at
         FROM tasks t`
      );
      await runRaw(rawDb, 'DROP TABLE tasks');
      await runRaw(rawDb, 'ALTER TABLE tasks_migrated RENAME TO tasks');
      await runRaw(rawDb, 'COMMIT');
    } catch (err) {
      await runRaw(rawDb, 'ROLLBACK').catch(() => {});
      throw err;
    }
    await execRaw(rawDb, migration001);
  }

  await execRaw(rawDb, migration002);
  await runRaw(rawDb, 'PRAGMA foreign_keys = ON');
}

function createSqliteAdapter(sqliteConfig) {
  // Carregamento sob demanda para nao inicializar binario nativo em modo PostgreSQL
  const sqlite3 = require('sqlite3').verbose();
  const rawDb = new sqlite3.Database(sqliteConfig.filename);

  let readySettled = false;
  let readyError = null;
  const ready = initializeSqliteSchema(rawDb)
    .then(() => {
      readySettled = true;
    })
    .catch((err) => {
      readySettled = true;
      readyError = err;
    });

  function whenReady(fn, onError) {
    if (readySettled) {
      if (readyError) return onError(readyError);
      return fn();
    }
    ready.then(() => {
      if (readyError) return onError(readyError);
      fn();
    });
  }

  const adapter = {
    dialect: 'sqlite',
    filename: sqliteConfig.filename,

    ready() {
      return ready.then(() => {
        if (readyError) throw readyError;
      });
    },

    get(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      whenReady(
        () => {
          rawDb.get(sql, args, (err, row) => {
            if (callback) callback(err, row);
          });
        },
        (err) => {
          if (callback) callback(err);
        }
      );
      return adapter;
    },

    all(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      whenReady(
        () => {
          rawDb.all(sql, args, (err, rows) => {
            if (callback) callback(err, rows);
          });
        },
        (err) => {
          if (callback) callback(err);
        }
      );
      return adapter;
    },

    run(sql, params, cb) {
      const { args, callback } = normalizeArgs(params, cb);
      whenReady(
        () => {
          rawDb.run(sql, args, function (err) {
            if (callback) callback.call(this, err);
          });
        },
        (err) => {
          if (callback) {
            callback.call({ lastID: 0, changes: 0 }, err);
          } else {
            console.error('[db:sqlite] Erro de execucao:', sanitizeErrorMessage(err));
          }
        }
      );
      return adapter;
    },

    serialize(fn) {
      if (typeof fn !== 'function') return adapter;
      whenReady(
        () => rawDb.serialize(fn),
        (err) => {
          console.error('[db:sqlite] Erro ao serializar operacoes:', sanitizeErrorMessage(err));
        }
      );
      return adapter;
    },

    close(cb) {
      const promise = ready.finally(() => new Promise((resolve, reject) => {
        rawDb.close((err) => (err ? reject(err) : resolve()));
      }));

      if (typeof cb === 'function') {
        promise.then(() => cb(null), (err) => cb(err));
        return adapter;
      }
      return promise;
    }
  };

  return adapter;
}

module.exports = {
  createSqliteAdapter
};
