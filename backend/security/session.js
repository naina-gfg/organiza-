'use strict';

const crypto = require('node:crypto');
const { scheduleBackgroundTask } = require('./background');

// Expiracao padrao absoluta: 8 horas
const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const MIN_SESSION_TTL_MS = 1000;
const MAX_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_TOKEN_BYTES = 32;
const REVOKED_RETENTION_MS = 24 * 60 * 60 * 1000;

function resolveSessionTtlMs(env = process.env) {
  const rawMs = env.SESSION_TTL_MS;
  if (typeof rawMs === 'string' && /^\d+$/.test(rawMs.trim())) {
    const parsed = Number(rawMs.trim());
    if (Number.isSafeInteger(parsed) && parsed >= MIN_SESSION_TTL_MS && parsed <= MAX_SESSION_TTL_MS) {
      return parsed;
    }
  }
  const rawSeconds = env.SESSION_TTL_SECONDS;
  if (typeof rawSeconds === 'string' && /^\d+$/.test(rawSeconds.trim())) {
    const parsed = Number(rawSeconds.trim()) * 1000;
    if (Number.isSafeInteger(parsed) && parsed >= MIN_SESSION_TTL_MS && parsed <= MAX_SESSION_TTL_MS) {
      return parsed;
    }
  }
  return DEFAULT_SESSION_TTL_MS;
}

function hashSessionToken(token) {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

function isValidTokenFormat(token) {
  return typeof token === 'string' && token.length >= 32 && token.length <= 256 && /^[A-Za-z0-9_-]+$/.test(token);
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

async function cleanupExpiredSessions(db, { nowMs = Date.now(), revokedGraceMs = REVOKED_RETENTION_MS } = {}) {
  const nowIso = new Date(nowMs).toISOString();
  const revokedBeforeIso = new Date(nowMs - revokedGraceMs).toISOString();
  const cleanup = () => dbRun(
    db,
    'DELETE FROM sessions WHERE expires_at <= ? OR (revoked_at IS NOT NULL AND revoked_at <= ?)',
    [nowIso, revokedBeforeIso]
  );
  const result = typeof db.withSessionCleanup === 'function'
    ? await db.withSessionCleanup(cleanup)
    : await cleanup();
  return result.changes;
}

async function createSession(db, userId, { ttlMs = DEFAULT_SESSION_TTL_MS, nowMs = Date.now() } = {}) {
  const token = crypto.randomBytes(SESSION_TOKEN_BYTES).toString('base64url');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  const insertSession = () => dbRun(
    db,
    'INSERT INTO sessions (user_id, token_hash, expires_at) VALUES (?, ?, ?)',
    [userId, tokenHash, expiresAt]
  );
  if (typeof db.withUserContext === 'function') await db.withUserContext(Number(userId), insertSession);
  else await insertSession();

  // Limpeza controlada via waitUntil (Vercel) / promessa protegida local
  scheduleBackgroundTask(cleanupExpiredSessions(db, { nowMs }));

  return { token, expiresAt };
}

async function validateSession(db, token, { nowMs = Date.now() } = {}) {
  if (!isValidTokenFormat(token)) {
    return null;
  }

  const tokenHash = hashSessionToken(token);
  const findSession = () => dbGet(
    db,
    `SELECT s.id, s.user_id, s.expires_at, s.revoked_at
     FROM sessions s
     WHERE s.token_hash = ?`,
    [tokenHash]
  );
  const row = typeof db.withTokenContext === 'function'
    ? await db.withTokenContext(tokenHash, findSession)
    : await findSession();

  if (!row || row.revoked_at !== null) {
    return null;
  }

  const expiresMs = new Date(row.expires_at).getTime();
  if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) {
    const removeExpired = () => dbRun(db, 'DELETE FROM sessions WHERE id = ?', [Number(row.id)]);
    await (typeof db.withTokenContext === 'function'
      ? db.withTokenContext(tokenHash, removeExpired)
      : removeExpired()).catch(() => {});
    return null;
  }

  return {
    sessionId: Number(row.id),
    userId: Number(row.user_id),
    tokenHash,
    expiresAt: new Date(expiresMs).toISOString()
  };
}

async function revokeSession(db, { sessionId, userId, tokenHash }, { nowMs = Date.now() } = {}) {
  const revokedAt = new Date(nowMs).toISOString();
  if (sessionId && userId) {
    const result = await dbRun(
      db,
      'UPDATE sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL',
      [revokedAt, sessionId, userId]
    );
    return result.changes;
  }
  if (tokenHash) {
    const revokeByToken = () => dbRun(
      db,
      'UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL',
      [revokedAt, tokenHash]
    );
    const result = typeof db.withTokenContext === 'function'
      ? await db.withTokenContext(tokenHash, revokeByToken)
      : await revokeByToken();
    return result.changes;
  }
  return 0;
}

module.exports = {
  DEFAULT_SESSION_TTL_MS,
  SESSION_TOKEN_BYTES,
  resolveSessionTtlMs,
  hashSessionToken,
  isValidTokenFormat,
  createSession,
  validateSession,
  revokeSession,
  cleanupExpiredSessions
};
