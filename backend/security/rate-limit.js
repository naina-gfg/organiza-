'use strict';

const crypto = require('node:crypto');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;
const DEFAULT_LOGIN_MAX = 10;
const DEFAULT_LOGIN_ACCOUNT_MAX = 10;
const DEFAULT_REGISTER_MAX = 10;

function parseBoundedInt(rawValue, fallback, min, max) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }
  const trimmed = String(rawValue).trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function resolveRateLimitConfig(env = process.env) {
  return {
    windowMs: parseBoundedInt(env.RATE_LIMIT_WINDOW_MS, DEFAULT_WINDOW_MS, 500, 24 * 60 * 60 * 1000),
    blockMs: parseBoundedInt(env.RATE_LIMIT_BLOCK_MS, DEFAULT_BLOCK_MS, 500, 24 * 60 * 60 * 1000),
    loginMax: parseBoundedInt(env.RATE_LIMIT_LOGIN_MAX, DEFAULT_LOGIN_MAX, 1, 1000),
    loginAccountMax: parseBoundedInt(env.RATE_LIMIT_LOGIN_ACCOUNT_MAX, DEFAULT_LOGIN_ACCOUNT_MAX, 1, 1000),
    registerMax: parseBoundedInt(env.RATE_LIMIT_REGISTER_MAX, DEFAULT_REGISTER_MAX, 1, 1000)
  };
}

function resolveTrustProxy(env = process.env) {
  const raw = typeof env.TRUST_PROXY === 'string' ? env.TRUST_PROXY.trim().toLowerCase() : '';
  if (!raw || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    return hops > 0 && hops <= 10 ? hops : false;
  }
  return raw;
}

function normalizeIp(ip) {
  if (typeof ip !== 'string' || !ip.trim()) return 'unknown';
  const trimmed = ip.trim();
  if (trimmed.startsWith('::ffff:')) {
    return trimmed.slice(7);
  }
  return trimmed;
}

/**
 * Extrai o endereco de origem de forma segura:
 * - Quando TRUST_PROXY=false (padrao), ignora X-Forwarded-For enviado pelo cliente
 *   e utiliza exclusivamente req.socket.remoteAddress.
 * - Quando TRUST_PROXY esta configurado explicitamente no Express (ex.: Vercel em PROD-03),
 *   utiliza req.ip ja resolvido segundo o numero de proxies confiaveis.
 */
function getClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy && req && typeof req.ip === 'string' && req.ip.trim()) {
    return normalizeIp(req.ip);
  }
  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return normalizeIp(remote);
}

function makeRateKey(scope, identifier) {
  const digest = crypto.createHash('sha256')
    .update(`${scope}:${String(identifier || 'unknown')}`, 'utf8')
    .digest('hex');
  return `${scope}:${digest}`;
}

function dbGet(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

function dbRun(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

const ATOMIC_CONSUME_SQL = `
  INSERT INTO rate_limits (rate_key, attempts, window_expires_at, blocked_until)
  VALUES (?, 1, CAST(? AS BIGINT), NULL)
  ON CONFLICT (rate_key) DO UPDATE SET
    attempts = CASE
      WHEN rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until > CAST(? AS BIGINT)
        THEN rate_limits.attempts
      WHEN rate_limits.window_expires_at <= CAST(? AS BIGINT)
        OR (rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until <= CAST(? AS BIGINT))
        THEN 1
      ELSE rate_limits.attempts + 1
    END,
    window_expires_at = CASE
      WHEN rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until > CAST(? AS BIGINT)
        THEN rate_limits.window_expires_at
      WHEN rate_limits.window_expires_at <= CAST(? AS BIGINT)
        OR (rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until <= CAST(? AS BIGINT))
        THEN CAST(? AS BIGINT)
      ELSE rate_limits.window_expires_at
    END,
    blocked_until = CASE
      WHEN rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until > CAST(? AS BIGINT)
        THEN rate_limits.blocked_until
      WHEN (
        rate_limits.window_expires_at <= CAST(? AS BIGINT)
        OR (rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until <= CAST(? AS BIGINT))
      ) AND 1 > CAST(? AS INTEGER)
        THEN CAST(? AS BIGINT)
      WHEN rate_limits.window_expires_at <= CAST(? AS BIGINT)
        OR (rate_limits.blocked_until IS NOT NULL AND rate_limits.blocked_until <= CAST(? AS BIGINT))
        THEN CAST(NULL AS BIGINT)
      WHEN rate_limits.attempts + 1 > CAST(? AS INTEGER)
        THEN CAST(? AS BIGINT)
      ELSE CAST(NULL AS BIGINT)
    END
  RETURNING attempts, window_expires_at, blocked_until
`;

async function consumeRateLimit(db, { scope, identifier, maxAttempts, windowMs, blockMs, nowMs = Date.now() }) {
  const rateKey = makeRateKey(scope, identifier);
  const windowExpiresAt = nowMs + windowMs;
  const blockedUntilTarget = nowMs + blockMs;

  const row = await dbGet(db, ATOMIC_CONSUME_SQL, [
    rateKey,
    windowExpiresAt,
    nowMs,
    nowMs,
    nowMs,
    nowMs,
    nowMs,
    nowMs,
    windowExpiresAt,
    nowMs,
    nowMs,
    nowMs,
    maxAttempts,
    blockedUntilTarget,
    nowMs,
    nowMs,
    maxAttempts,
    blockedUntilTarget
  ]);

  const blockedUntil = row && row.blocked_until != null ? Number(row.blocked_until) : null;
  if (blockedUntil !== null && blockedUntil > nowMs) {
    return {
      allowed: false,
      attempts: Number(row.attempts),
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((blockedUntil - nowMs) / 1000))
    };
  }

  const attempts = Number(row?.attempts ?? 1);
  return {
    allowed: true,
    attempts,
    remaining: Math.max(0, maxAttempts - attempts),
    retryAfterSeconds: 0
  };
}

async function resetRateLimit(db, { scope, identifier }) {
  const rateKey = makeRateKey(scope, identifier);
  await dbRun(db, 'DELETE FROM rate_limits WHERE rate_key = ?', [rateKey]);
}

async function cleanupExpiredRateLimits(db, { nowMs = Date.now() } = {}) {
  const result = await dbRun(
    db,
    'DELETE FROM rate_limits WHERE window_expires_at <= ? AND (blocked_until IS NULL OR blocked_until <= ?)',
    [nowMs, nowMs]
  );
  return result.changes;
}

module.exports = {
  DEFAULT_WINDOW_MS,
  DEFAULT_BLOCK_MS,
  DEFAULT_LOGIN_MAX,
  DEFAULT_LOGIN_ACCOUNT_MAX,
  DEFAULT_REGISTER_MAX,
  resolveRateLimitConfig,
  resolveTrustProxy,
  getClientIp,
  makeRateKey,
  consumeRateLimit,
  resetRateLimit,
  cleanupExpiredRateLimits
};
