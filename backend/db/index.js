'use strict';

const { resolveDatabaseConfig } = require('./config');
const { createSqliteAdapter } = require('./sqlite-adapter');
const { createPostgresAdapter } = require('./postgres-adapter');

function createDatabase(env = process.env, options = {}) {
  const config = resolveDatabaseConfig(env);
  if (config.dialect === 'postgres') {
    return createPostgresAdapter(config.postgres, options.PoolImpl);
  }
  return createSqliteAdapter(config.sqlite);
}

module.exports = {
  createDatabase,
  resolveDatabaseConfig
};
