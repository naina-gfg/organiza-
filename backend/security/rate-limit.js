'use strict';

const crypto = require('node:crypto');
const net = require('node:net');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_BLOCK_MS = 15 * 60 * 1000;
// Limites pensados para equilibrar protecao contra abuso com redes compartilhadas/academicas (NAT):
// - login por IP: 30 tentativas/15min permite multiplos alunos no mesmo IP universitario
// - login por conta: 10 tentativas/15min protege especificamente cada e-mail (resetado ao autenticar)
// - cadastro por IP: 20 tentativas/15min suporta cadastros simultaneos em laboratorio/sala
const DEFAULT_LOGIN_MAX = 30;
const DEFAULT_LOGIN_ACCOUNT_MAX = 10;
const DEFAULT_REGISTER_MAX = 20;

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

/**
 * Resolve o modo de confianca de proxy de forma estrita:
 * - Nunca aceita TRUST_PROXY=true (evita confiar cegamente em X-Forwarded-For arbitrario).
 * - Fora da Vercel, o padrao e false (usa exclusivamente req.socket.remoteAddress).
 * - Na Vercel (VERCEL=1), quando nao definido explicitamente como false/0, usa o modo 'vercel'
 *   com app.set('trust proxy', 1) e leitura prioritaria de x-vercel-forwarded-for / x-real-ip.
 */
function resolveTrustProxy(env = process.env) {
  const raw = typeof env.TRUST_PROXY === 'string' ? env.TRUST_PROXY.trim().toLowerCase() : '';
  if (!raw) {
    return env.VERCEL === '1' ? 'vercel' : false;
  }
  if (raw === 'false' || raw === '0' || raw === 'off') {
    return false;
  }
  if (raw === 'true') {
    throw new Error(
      'Configuracao insegura: TRUST_PROXY=true nao e permitido. Use false, vercel ou numero explicito de saltos (1..5).'
    );
  }
  if (raw === 'vercel') {
    return 'vercel';
  }
  if (/^\d+$/.test(raw)) {
    const hops = Number(raw);
    if (hops >= 1 && hops <= 5) {
      return hops;
    }
    throw new Error('Configuracao invalida: TRUST_PROXY numerico deve estar entre 1 e 5.');
  }
  throw new Error(`TRUST_PROXY invalido: "${raw}". Valores aceitos: false, vercel ou inteiro de 1 a 5.`);
}

function toExpressTrustProxy(trustProxy) {
  if (trustProxy === 'vercel') return 1;
  if (typeof trustProxy === 'number' && Number.isSafeInteger(trustProxy) && trustProxy > 0) {
    return trustProxy;
  }
  return false;
}

/**
 * Valida e normaliza enderecos IPv4 e IPv6 (inclusive IPv4-mapped IPv6 e porta opcional).
 * Retorna null se a entrada nao for um IP valido segundo net.isIP.
 */
function normalizeIp(rawIp) {
  if (typeof rawIp !== 'string') return null;
  let candidate = rawIp.trim();
  if (!candidate || candidate.length > 64) return null;

  // Remove zona IPv6 se presente (ex.: fe80::1%eth0)
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex !== -1) {
    candidate = candidate.slice(0, zoneIndex);
  }

  // Trata [IPv6]:porta ou [IPv6]
  if (candidate.startsWith('[')) {
    const closing = candidate.indexOf(']');
    if (closing === -1) return null;
    const after = candidate.slice(closing + 1);
    if (after && !/^:\d{1,5}$/.test(after)) return null;
    candidate = candidate.slice(1, closing);
  } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d{1,5}$/.test(candidate)) {
    candidate = candidate.slice(0, candidate.lastIndexOf(':'));
  }

  // Converte ::ffff:a.b.c.d ou ::ffff:x:y para IPv4 canonico quando aplicavel
  if (candidate.toLowerCase().startsWith('::ffff:')) {
    const tail = candidate.slice(7);
    if (net.isIPv4(tail)) {
      candidate = tail;
    }
  }

  const version = net.isIP(candidate);
  if (version === 4) {
    return candidate;
  }
  if (version === 6) {
    try {
      const normalized = new URL(`http://[${candidate}]`).hostname.slice(1, -1);
      if (normalized.startsWith('::ffff:')) {
        const mapped = normalized.slice(7);
        if (net.isIPv4(mapped)) return mapped;
      }
      return normalized;
    } catch {
      return null;
    }
  }
  return null;
}

function getHeaderValue(req, name) {
  const headers = req && req.headers;
  if (!headers) return '';
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return String(value[value.length - 1] || '');
  return typeof value === 'string' ? value : '';
}

function extractRightmostIpFromHeader(headerValue) {
  if (!headerValue) return null;
  const parts = headerValue.split(',');
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const normalized = normalizeIp(parts[i]);
    if (normalized) return normalized;
  }
  return null;
}

/**
 * Extrai o endereco de origem de forma segura:
 * - trustProxy=false: ignora X-Forwarded-For, X-Vercel-Forwarded-For e X-Real-IP,
 *   usando apenas req.socket.remoteAddress validado/normalizado.
 * - trustProxy='vercel': prioriza cabecalhos gerenciados pela borda da Vercel
 *   (x-vercel-forwarded-for, x-real-ip) e req.ip, sempre validados por net.isIP.
 * - trustProxy=N (1..5 saltos): usa req.ip resolvido pelo Express para N proxies confiaveis.
 */
function getClientIp(req, { trustProxy = false } = {}) {
  if (trustProxy === 'vercel') {
    const fromVercelHeader = extractRightmostIpFromHeader(getHeaderValue(req, 'x-vercel-forwarded-for'));
    if (fromVercelHeader) return fromVercelHeader;
    const fromRealIp = normalizeIp(getHeaderValue(req, 'x-real-ip'));
    if (fromRealIp) return fromRealIp;
    const fromReqIp = normalizeIp(req && req.ip);
    if (fromReqIp) return fromReqIp;
  } else if (
    (typeof trustProxy === 'number' && Number.isSafeInteger(trustProxy) && trustProxy > 0) ||
    trustProxy === true
  ) {
    const fromReqIp = normalizeIp(req && req.ip);
    if (fromReqIp) return fromReqIp;
  }

  const remote = req?.socket?.remoteAddress || req?.connection?.remoteAddress || '';
  return normalizeIp(remote) || 'unknown';
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
  toExpressTrustProxy,
  normalizeIp,
  getClientIp,
  makeRateKey,
  consumeRateLimit,
  resetRateLimit,
  cleanupExpiredRateLimits
};
