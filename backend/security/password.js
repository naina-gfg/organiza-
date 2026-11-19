'use strict';

const crypto = require('node:crypto');

// OWASP Authentication Cheat Sheet (sem MFA): minimo 15 caracteres; maximo >= 64 (128).
const MIN_PASSWORD_LENGTH = 15;
const MAX_PASSWORD_LENGTH = 128;

// OWASP Password Storage Cheat Sheet para scrypt (tier equilibrado 32 MiB para serverless):
// N = 2^15 (32768), r = 8 (1024 bytes), p = 3 => ~32 MiB por operacao (~550 ms) e maxmem 64 MiB.
const SCRYPT_PARAMS = Object.freeze({
  N: 32768,
  r: 8,
  p: 3,
  keylen: 32,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024
});

const SCRYPT_HASH_REGEX = /^\$scrypt\$v=1\$N=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9_-]+)\$([A-Za-z0-9_-]+)$/;

class CryptoBusyError extends Error {
  constructor(message = 'Servidor temporariamente ocupado em autenticacao. Tente novamente em instantes.') {
    super(message);
    this.name = 'CryptoBusyError';
    this.status = 503;
    this.retryAfterSeconds = 2;
  }
}

function parsePositiveBound(rawValue, fallback, min, max) {
  if (rawValue === undefined || rawValue === null || String(rawValue).trim() === '') {
    return fallback;
  }
  const trimmed = String(rawValue).trim();
  if (!/^\d+$/.test(trimmed)) return fallback;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) return fallback;
  return parsed;
}

function parseScryptHash(storedHash) {
  if (typeof storedHash !== 'string') return null;
  const match = SCRYPT_HASH_REGEX.exec(storedHash);
  if (!match) return null;

  const N = Number(match[1]);
  const r = Number(match[2]);
  const p = Number(match[3]);
  const isPowerOfTwo = N > 0 && (N & (N - 1)) === 0;
  if (
    !isPowerOfTwo ||
    N < 16384 || N > 131072 ||
    r < 1 || r > 16 ||
    p < 1 || p > 8 ||
    128 * N * r > 256 * 1024 * 1024
  ) {
    return null;
  }

  const salt = Buffer.from(match[4], 'base64url');
  const expectedKey = Buffer.from(match[5], 'base64url');
  if (salt.length < 16 || salt.length > 64 || expectedKey.length < 32 || expectedKey.length > 64) {
    return null;
  }

  return { N, r, p, salt, expectedKey };
}

function createPasswordManager(env = process.env) {
  const maxConcurrent = parsePositiveBound(env.SCRYPT_MAX_CONCURRENT, 4, 1, 16);
  const maxQueue = parsePositiveBound(env.SCRYPT_MAX_QUEUE, 16, 1, 200);

  let activeCount = 0;
  const waitQueue = [];

  function acquireSlot() {
    if (activeCount < maxConcurrent) {
      activeCount += 1;
      return Promise.resolve();
    }
    if (waitQueue.length >= maxQueue) {
      return Promise.reject(new CryptoBusyError());
    }
    return new Promise((resolve) => {
      waitQueue.push(resolve);
    });
  }

  function releaseSlot() {
    const next = waitQueue.shift();
    if (next) {
      next();
    } else if (activeCount > 0) {
      activeCount -= 1;
    }
  }

  async function deriveScrypt(password, salt, { N, r, p, keylen, maxmem }) {
    await acquireSlot();
    try {
      return await new Promise((resolve, reject) => {
        crypto.scrypt(password, salt, keylen, { N, r, p, maxmem }, (err, derivedKey) => {
          if (err) return reject(err);
          resolve(derivedKey);
        });
      });
    } finally {
      releaseSlot();
    }
  }

  // Salt e hash dummy aleatorios por processo para equalizar tempo quando o e-mail nao existe
  const dummySalt = crypto.randomBytes(SCRYPT_PARAMS.saltBytes);
  const dummyExpected = crypto.randomBytes(SCRYPT_PARAMS.keylen);

  function validatePasswordStrength(password) {
    if (typeof password !== 'string') {
      return { valid: false, error: 'Senha invalida.' };
    }
    if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
      return {
        valid: false,
        error: `A senha deve ter entre ${MIN_PASSWORD_LENGTH} e ${MAX_PASSWORD_LENGTH} caracteres.`
      };
    }
    return { valid: true };
  }

  async function hashRawPassword(password) {
    const salt = crypto.randomBytes(SCRYPT_PARAMS.saltBytes);
    const derived = await deriveScrypt(password, salt, SCRYPT_PARAMS);
    return `$scrypt$v=1$N=${SCRYPT_PARAMS.N},r=${SCRYPT_PARAMS.r},p=${SCRYPT_PARAMS.p}$${salt.toString('base64url')}$${derived.toString('base64url')}`;
  }

  async function hashPassword(password) {
    const check = validatePasswordStrength(password);
    if (!check.valid) {
      throw new Error(check.error);
    }
    return hashRawPassword(password);
  }

  /**
   * Atualiza um hash scrypt anteriormente emitido para os parametros atuais
   * exclusivamente apos autenticacao valida, preservando contas existentes.
   */
  async function upgradePasswordHash(password) {
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      throw new Error('Senha invalida para atualizacao de hash.');
    }
    return hashRawPassword(password);
  }

  function needsRehash(storedHash) {
    const parsed = parseScryptHash(storedHash);
    if (!parsed) return false;
    return (
      parsed.N !== SCRYPT_PARAMS.N ||
      parsed.r !== SCRYPT_PARAMS.r ||
      parsed.p !== SCRYPT_PARAMS.p ||
      parsed.salt.length !== SCRYPT_PARAMS.saltBytes ||
      parsed.expectedKey.length !== SCRYPT_PARAMS.keylen
    );
  }

  async function verifyDummyPassword() {
    const derived = await deriveScrypt('dummy-timing-equalizer', dummySalt, SCRYPT_PARAMS);
    crypto.timingSafeEqual(derived, dummyExpected);
    return false;
  }

  async function verifyPassword(password, storedHash) {
    if (typeof password !== 'string' || password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
      return false;
    }

    const parsed = parseScryptHash(storedHash);
    if (!parsed) {
      return verifyDummyPassword();
    }

    const { N, r, p, salt, expectedKey } = parsed;
    const maxmem = Math.max(SCRYPT_PARAMS.maxmem, 256 * N * r);
    const derived = await deriveScrypt(password, salt, {
      N,
      r,
      p,
      keylen: expectedKey.length,
      maxmem
    });

    if (derived.length !== expectedKey.length) {
      return false;
    }
    return crypto.timingSafeEqual(derived, expectedKey);
  }

  function getStats() {
    return {
      activeCount,
      queueLength: waitQueue.length,
      maxConcurrent,
      maxQueue
    };
  }

  return {
    MIN_PASSWORD_LENGTH,
    MAX_PASSWORD_LENGTH,
    SCRYPT_PARAMS,
    validatePasswordStrength,
    hashPassword,
    upgradePasswordHash,
    needsRehash,
    verifyPassword,
    verifyDummyPassword,
    getStats
  };
}

module.exports = {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  CryptoBusyError,
  createPasswordManager
};
