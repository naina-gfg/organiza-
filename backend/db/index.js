'use strict';

const { resolveDatabaseConfig } = require('./config');

function createDatabase(env = process.env, options = {}) {
  const config = resolveDatabaseConfig(env);
  if (config.dialect === 'postgres') {
    const { createPostgresAdapter } = require('./postgres-adapter');
    return createPostgresAdapter(config.postgres, options.PoolImpl);
  }
  const { createSqliteAdapter } = require('./sqlite-adapter');
  return createSqliteAdapter(config.sqlite);
}

module.exports = {
  createDatabase,
  resolveDatabaseConfig
};
