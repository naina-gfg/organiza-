'use strict';

const fs = require('node:fs');
const path = require('node:path');

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const SQLITE_CLIENTS = new Set(['sqlite', 'sqlite3']);
const POSTGRES_CLIENTS = new Set(['postgres', 'postgresql', 'pg']);

/**
 * Mascara credenciais em strings de conexao PostgreSQL para impedir vazamento em logs.
 */
function maskConnectionString(text) {
  if (typeof text !== 'string' || !text) return '';
  return text
    .replace(
      /\b(postgres(?:ql)?:\/\/)([^\s/@]+@)/gi,
      '$1***:***@'
    )
    .replace(
      /([?&](?:password|pass|pwd|secret|token)=)([^&\s]+)/gi,
      '$1***'
    );
}

/**
 * Sanitiza mensagens de erro antes de propagar ou registrar em log.
 */
function sanitizeErrorMessage(err) {
  const raw = err && typeof err.message === 'string'
    ? err.message
    : String(err || 'Erro desconhecido de banco de dados.');
  return maskConnectionString(raw);
}

function parsePositiveInt(rawValue, fallback, { name, min = 1, max = 600000 } = {}) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }
  const text = String(rawValue).trim();
  if (!/^\d+$/.test(text)) {
    throw new Error(`Configuracao invalida para ${name}: esperado inteiro positivo.`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`Configuracao fora do intervalo permitido para ${name} (${min}..${max}).`);
  }
  return parsed;
}

function isLocalHostname(hostname) {
  return LOCAL_HOSTS.has(String(hostname || '').trim().toLowerCase());
}

function parsePostgresUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl.trim());
  } catch {
    throw new Error('DATABASE_URL invalida: formato de URL PostgreSQL incorreto.');
  }

  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error('DATABASE_URL invalida: o protocolo deve ser postgres:// ou postgresql://.');
  }

  const hostname = parsed.hostname.replace(/^\[(.+)\]$/, '$1');
  if (!hostname) {
    throw new Error('DATABASE_URL invalida: host ausente.');
  }

  const port = parsed.port
    ? parsePositiveInt(parsed.port, 5432, { name: 'DATABASE_URL port', min: 1, max: 65535 })
    : 5432;

  const pathname = parsed.pathname.replace(/^\/+/, '');
  const database = pathname ? decodeURIComponent(pathname) : 'postgres';
  const user = parsed.username ? decodeURIComponent(parsed.username) : '';
  const password = parsed.password ? decodeURIComponent(parsed.password) : '';

  return {
    host: hostname,
    port,
    database,
    user,
    password,
    searchParams: parsed.searchParams
  };
}

function resolveSslOption({ hostname, searchParams, env, isProduction }) {
  const sslmode = (searchParams.get('sslmode') || '').trim().toLowerCase();
  const sslParam = (searchParams.get('ssl') || '').trim().toLowerCase();
  const envSsl = typeof env.DB_SSL === 'string' ? env.DB_SSL.trim().toLowerCase() : '';
  const rejectUnauthEnv = typeof env.DB_SSL_REJECT_UNAUTHORIZED === 'string'
    ? env.DB_SSL_REJECT_UNAUTHORIZED.trim().toLowerCase()
    : '';

  const explicitlyDisabled =
    envSsl === 'false' ||
    envSsl === '0' ||
    sslParam === 'false' ||
    sslParam === '0' ||
    sslmode === 'disable';

  const explicitlyInsecure =
    rejectUnauthEnv === 'false' ||
    rejectUnauthEnv === '0' ||
    sslmode === 'no-verify' ||
    sslmode === 'allow' ||
    sslmode === 'prefer';

  if (isProduction) {
    if (explicitlyDisabled) {
      throw new Error('Configuracao insegura: TLS nao pode ser desabilitado em producao.');
    }
    if (explicitlyInsecure) {
      throw new Error('Configuracao insegura: validacao estrita de certificado TLS e obrigatoria em producao.');
    }
  }

  if (explicitlyDisabled) {
    return false;
  }

  const localHost = isLocalHostname(hostname);
  const sslRequested =
    isProduction ||
    !localHost ||
    envSsl === 'true' ||
    envSsl === '1' ||
    sslParam === 'true' ||
    sslParam === '1' ||
    ['require', 'verify-ca', 'verify-full', 'no-verify'].includes(sslmode);

  if (!sslRequested) {
    return false;
  }

  const rejectUnauthorized = (rejectUnauthEnv === 'false' || rejectUnauthEnv === '0' || sslmode === 'no-verify')
    ? false
    : true;

  const sslConfig = { rejectUnauthorized };

  const caInline = typeof env.DB_SSL_CA === 'string' && env.DB_SSL_CA.trim()
    ? env.DB_SSL_CA.replace(/\\n/g, '\n')
    : null;
  const caFile = (typeof env.DB_SSL_CA_FILE === 'string' && env.DB_SSL_CA_FILE.trim()) ||
    (searchParams.get('sslrootcert') || '').trim() ||
    null;

  if (caInline) {
    sslConfig.ca = caInline;
  } else if (caFile) {
    try {
      sslConfig.ca = fs.readFileSync(path.resolve(caFile), 'utf8');
    } catch {
      throw new Error('Nao foi possivel ler o certificado CA especificado para TLS do PostgreSQL.');
    }
  }

  return sslConfig;
}

/**
 * Resolve de forma explicita o adaptador de banco a partir das variaveis de ambiente.
 * Bloqueia fallback silencioso para SQLite quando PostgreSQL ou producao estiverem configurados.
 */
function resolveDatabaseConfig(env = process.env) {
  const nodeEnv = typeof env.NODE_ENV === 'string' ? env.NODE_ENV.trim().toLowerCase() : '';
  const isProduction = nodeEnv === 'production' || env.VERCEL === '1' || env.VERCEL_ENV === 'production';

  const rawClient = typeof env.DB_CLIENT === 'string' ? env.DB_CLIENT.trim().toLowerCase() : '';
  if (rawClient && !SQLITE_CLIENTS.has(rawClient) && !POSTGRES_CLIENTS.has(rawClient)) {
    throw new Error(`DB_CLIENT invalido: "${rawClient}". Valores aceitos: sqlite, postgres.`);
  }

  const rawUrl = env.DATABASE_URL;
  if (typeof rawUrl === 'string' && rawUrl.length > 0 && rawUrl.trim() === '') {
    throw new Error('DATABASE_URL nao pode conter apenas espacos em branco.');
  }
  const hasDatabaseUrl = typeof rawUrl === 'string' && rawUrl.trim().length > 0;

  let dialect;
  if (POSTGRES_CLIENTS.has(rawClient)) {
    if (!hasDatabaseUrl) {
      throw new Error(
        'PostgreSQL selecionado via DB_CLIENT, mas DATABASE_URL nao esta configurada. Fallback para SQLite bloqueado.'
      );
    }
    dialect = 'postgres';
  } else if (SQLITE_CLIENTS.has(rawClient)) {
    if (isProduction) {
      throw new Error(
        'SQLite nao e permitido em ambiente de producao. Configure DB_CLIENT=postgres e DATABASE_URL.'
      );
    }
    dialect = 'sqlite';
  } else if (hasDatabaseUrl) {
    dialect = 'postgres';
  } else if (isProduction) {
    throw new Error(
      'DATABASE_URL obrigatoria em ambiente de producao. Fallback silencioso para SQLite bloqueado.'
    );
  } else {
    dialect = 'sqlite';
  }

  if (dialect === 'sqlite') {
    const rawSqlitePath = typeof env.SQLITE_DB_PATH === 'string' ? env.SQLITE_DB_PATH.trim() : '';
    const filename = rawSqlitePath
      ? (rawSqlitePath === ':memory:' ? ':memory:' : path.resolve(rawSqlitePath))
      : path.resolve(__dirname, '..', 'plataforma.db');

    return {
      dialect: 'sqlite',
      isProduction,
      sqlite: { filename }
    };
  }

  const parsedUrl = parsePostgresUrl(rawUrl);
  const ssl = resolveSslOption({
    hostname: parsedUrl.host,
    searchParams: parsedUrl.searchParams,
    env,
    isProduction
  });

  const poolConfig = {
    host: parsedUrl.host,
    port: parsedUrl.port,
    database: parsedUrl.database,
    user: parsedUrl.user,
    password: parsedUrl.password,
    ssl,
    max: parsePositiveInt(env.DB_POOL_MAX, isProduction ? 5 : 10, {
      name: 'DB_POOL_MAX',
      min: 1,
      max: 50
    }),
    min: 0,
    idleTimeoutMillis: parsePositiveInt(env.DB_IDLE_TIMEOUT_MS, 10000, {
      name: 'DB_IDLE_TIMEOUT_MS',
      min: 500,
      max: 300000
    }),
    connectionTimeoutMillis: parsePositiveInt(env.DB_CONNECTION_TIMEOUT_MS, 10000, {
      name: 'DB_CONNECTION_TIMEOUT_MS',
      min: 500,
      max: 120000
    }),
    query_timeout: parsePositiveInt(env.DB_QUERY_TIMEOUT_MS, 15000, {
      name: 'DB_QUERY_TIMEOUT_MS',
      min: 500,
      max: 120000
    }),
    allowExitOnIdle: true,
    application_name: 'organiza-plus'
  };

  return {
    dialect: 'postgres',
    isProduction,
    postgres: {
      poolConfig,
      safeTarget: `${parsedUrl.host}:${parsedUrl.port}/${parsedUrl.database}`
    }
  };
}

module.exports = {
  resolveDatabaseConfig,
  maskConnectionString,
  sanitizeErrorMessage,
  isLocalHostname
};
