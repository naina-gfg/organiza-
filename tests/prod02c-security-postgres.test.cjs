'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const { hashSessionToken, cleanupExpiredSessions } = require(path.join(ROOT, 'backend', 'security', 'session'));
const { cleanupExpiredRateLimits } = require(path.join(ROOT, 'backend', 'security', 'rate-limit'));
const { CONTENT_SECURITY_POLICY } = require(path.join(ROOT, 'backend', 'security', 'headers'));

function findPostgresBinDir() {
  const candidates = [
    process.env.PG_BIN,
    path.join(process.env.USERPROFILE || '', 'Tools', 'PostgreSQL17', 'pgsql', 'bin')
  ].filter(Boolean);

  for (const dir of candidates) {
    if (
      fs.existsSync(path.join(dir, 'initdb.exe')) &&
      fs.existsSync(path.join(dir, 'postgres.exe')) &&
      fs.existsSync(path.join(dir, 'pg_ctl.exe'))
    ) {
      return dir;
    }
  }
  return null;
}

function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

function loadIsolatedServer(envOverrides) {
  const savedEnv = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  const databasePath = require.resolve(path.join(ROOT, 'backend', 'database.js'));
  const serverPath = require.resolve(path.join(ROOT, 'backend', 'server.js'));
  delete require.cache[databasePath];
  delete require.cache[serverPath];

  try {
    return require(serverPath);
  } finally {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function startHttpServer(app) {
  const server = await new Promise((resolve, reject) => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    instance.once('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    db: app.db,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (app.db && typeof app.db.close === 'function') {
        await app.db.close();
      }
    }
  };
}

async function rawRequest(baseUrl, route, { method = 'GET', token, body, rawBody, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (rawBody !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] || 'application/json';
    payload = rawBody;
  } else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, { method, headers, body: payload });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, body: json, text };
}

const pgBin = findPostgresBinDir();
assert.ok(pgBin, 'Binarios locais do PostgreSQL 17 nao encontrados para testes reais.');

const m001 = fs.readFileSync(path.join(ROOT, 'migrations', '001_initial_schema.sql'), 'utf8');
const m002 = fs.readFileSync(path.join(ROOT, 'migrations', '002_roles_and_rls.sql'), 'utf8');
const m003 = fs.readFileSync(path.join(ROOT, 'migrations', '003_sessions_and_rate_limits.sql'), 'utf8');
const m004 = fs.readFileSync(path.join(ROOT, 'migrations', '004_sessions_rls_and_grants.sql'), 'utf8');
const rb004 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '004_sessions_rls_and_grants_down.sql'), 'utf8');
const rb003 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '003_sessions_and_rate_limits_down.sql'), 'utf8');
const rb002 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '002_roles_and_rls_down.sql'), 'utf8');
const rb001 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '001_initial_schema_down.sql'), 'utf8');

let cluster = null;

test.before(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-pg17-sec-'));
  const dataDir = path.join(baseDir, 'data');

  execFileSync(
    path.join(pgBin, 'initdb.exe'),
    ['-D', dataDir, '-U', 'postgres', '--encoding=UTF8', '--auth=trust', '--no-instructions'],
    { stdio: 'pipe' }
  );

  const port = await findFreePort();
  const proc = spawn(
    path.join(pgBin, 'postgres.exe'),
    ['-D', dataDir, '-p', String(port), '-h', '127.0.0.1', '-k', baseDir],
    { stdio: ['ignore', 'ignore', 'ignore'] }
  );

  const adminDefaultPool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'postgres',
    ssl: false
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      await adminDefaultPool.query('SELECT 1');
      break;
    } catch {
      await new Promise(r => setTimeout(r, 150));
    }
  }

  await adminDefaultPool.query('CREATE DATABASE organiza_sec_test');
  await adminDefaultPool.query('CREATE DATABASE organiza_sec_rb');

  const runtimePassword = crypto.randomBytes(18).toString('hex');
  const adminPool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'organiza_sec_test',
    ssl: false
  });

  await adminPool.query(m001);
  await adminPool.query(m002);
  await adminPool.query(m003);
  await adminPool.query(m004);
  await adminPool.query(`ALTER ROLE organiza_app WITH LOGIN PASSWORD '${runtimePassword}'`);

  cluster = {
    baseDir,
    dataDir,
    port,
    proc,
    adminDefaultPool,
    adminPool,
    runtimePassword,
    runtimeDatabaseUrl: `postgresql://organiza_app:${runtimePassword}@127.0.0.1:${port}/organiza_sec_test`
  };
});

test.after(async () => {
  if (!cluster) return;
  await cluster.adminPool.end().catch(() => {});
  await cluster.adminDefaultPool.end().catch(() => {});
  try {
    execFileSync(path.join(pgBin, 'pg_ctl.exe'), ['-D', cluster.dataDir, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  } catch {}
  if (!cluster.proc.killed) {
    await new Promise((resolve) => {
      cluster.proc.once('exit', resolve);
      setTimeout(() => {
        try { cluster.proc.kill(); } catch {}
        resolve();
      }, 2500);
    });
  }
  fs.rmSync(cluster.baseDir, { recursive: true, force: true });
});

test('PostgreSQL 17: RLS, permissões mínimas e bloqueio público em sessions e rate_limits', async () => {
  const rls = await cluster.adminPool.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('users', 'disciplines', 'tasks', 'sessions', 'rate_limits')
    ORDER BY relname
  `);
  assert.deepEqual(rls.rows, [
    { relname: 'disciplines', relrowsecurity: true },
    { relname: 'rate_limits', relrowsecurity: true },
    { relname: 'sessions', relrowsecurity: true },
    { relname: 'tasks', relrowsecurity: true },
    { relname: 'users', relrowsecurity: true }
  ]);

  const publicPrivs = await cluster.adminPool.query(`
    SELECT table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee = 'PUBLIC' AND table_schema = 'public'
      AND table_name IN ('sessions', 'rate_limits')
  `);
  assert.equal(publicPrivs.rows.length, 0);

  const publicPolicies = await cluster.adminPool.query(`
    SELECT tablename, policyname
    FROM pg_policies
    WHERE schemaname = 'public'
      AND ('public' = ANY(roles) OR 'anon' = ANY(roles) OR 'authenticated' = ANY(roles))
  `);
  assert.equal(publicPolicies.rows.length, 0);

  const runtimePool = new Pool({
    host: '127.0.0.1',
    port: cluster.port,
    user: 'organiza_app',
    password: cluster.runtimePassword,
    database: 'organiza_sec_test',
    ssl: false
  });
  try {
    await assert.rejects(() => runtimePool.query('TRUNCATE public.sessions'), (e) => e.code === '42501');
    await assert.rejects(() => runtimePool.query('DROP TABLE public.rate_limits'), (e) => e.code === '42501');
  } finally {
    await runtimePool.end();
  }
});

test('PostgreSQL 17: scrypt, sessões entre duas instâncias, reinicialização, expiração, logout, rate limiting concorrente e hardening HTTP', async () => {
  const envCfg = {
    NODE_ENV: 'test',
    DB_CLIENT: 'postgres',
    DATABASE_URL: cluster.runtimeDatabaseUrl,
    DB_SSL: 'false',
    SESSION_TTL_MS: '15000',
    RATE_LIMIT_LOGIN_MAX: '6',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: '6',
    RATE_LIMIT_REGISTER_MAX: '3',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_BLOCK_MS: '1500'
  };

  let instanceA = await startHttpServer(loadIsolatedServer(envCfg));
  let instanceB = await startHttpServer(loadIsolatedServer(envCfg));

  try {
    // Cadastro e verificacao de hash scrypt no PostgreSQL
    const regA = await rawRequest(instanceA.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Mariana', email: 'mariana@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(regA.status, 201);

    const regB = await rawRequest(instanceA.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Mariana 2', email: 'mariana2@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(regB.status, 201);

    const userRows = await cluster.adminPool.query(
      'SELECT id, password_hash FROM users WHERE email IN ($1, $2) ORDER BY id',
      ['mariana@pgsec.local', 'mariana2@pgsec.local']
    );
    assert.notEqual(userRows.rows[0].password_hash, userRows.rows[1].password_hash);
    assert.match(userRows.rows[0].password_hash, /^\$scrypt\$v=1\$/);
    assert.equal(userRows.rows[0].password_hash.includes('PgPassword!2026'), false);

    // Rate limit de cadastro (terceiro permitido, quarto bloqueado)
    const regC = await rawRequest(instanceB.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Lucas', email: 'lucas@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(regC.status, 201);
    const regBlocked = await rawRequest(instanceA.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Bloq', email: 'bloq@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(regBlocked.status, 429);
    assert.ok(Number(regBlocked.headers.get('retry-after')) >= 1);

    // Login na instancia A -> sessao persistida no PostgreSQL apenas como token_hash
    const loginA = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'mariana@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(loginA.status, 200);
    const token = loginA.body.token;
    assert.ok(token.length >= 43);

    const sessRows = await cluster.adminPool.query(
      'SELECT token_hash, revoked_at FROM sessions WHERE user_id = $1',
      [userRows.rows[0].id]
    );
    assert.equal(sessRows.rows.length, 1);
    assert.equal(sessRows.rows[0].token_hash, hashSessionToken(token));
    assert.notEqual(sessRows.rows[0].token_hash, token);

    // Funciona na instancia B independente
    const createDiscB = await rawRequest(instanceB.baseUrl, '/api/disciplines', {
      method: 'POST',
      token,
      body: { name: 'Segurança da Informação' }
    });
    assert.equal(createDiscB.status, 201);
    assert.equal(createDiscB.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
    assert.equal(createDiscB.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(createDiscB.headers.get('x-frame-options'), 'DENY');
    assert.match(createDiscB.headers.get('cache-control'), /no-store/);

    // Token adulterado e tentativa de SQL Injection rejeitados no PostgreSQL
    assert.equal(
      (await rawRequest(instanceB.baseUrl, '/api/dashboard', { token: `${token.slice(0, -1)}Z` })).status,
      401
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/login', {
        method: 'POST',
        body: { email: "' OR '1'='1", password: "' OR '1'='1" }
      })).status,
      401
    );

    // Validacoes diretas na API (data invalida, 404 JSON, 413) + isolamento entre contas
    const taskA = await rawRequest(instanceA.baseUrl, '/api/tasks', {
      method: 'POST',
      token,
      body: { title: 'Tarefa PG Segura', user_id: 9999, priority: 'Alta', due_date: '2026-12-01', discipline_id: createDiscB.body.id }
    });
    assert.equal(taskA.status, 201);
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token,
        body: { title: 'Data ruim', due_date: '2026-02-30', priority: 'Média' }
      })).status,
      400
    );
    assert.equal((await rawRequest(instanceA.baseUrl, '/api/inexistente', { token })).status, 404);
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token,
        body: { title: 'Grande', description: 'a'.repeat(20000) }
      })).status,
      413
    );

    const loginM2 = await rawRequest(instanceB.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'mariana2@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(loginM2.status, 200);
    const tokenM2 = loginM2.body.token;
    assert.equal((await rawRequest(instanceA.baseUrl, '/api/tasks', { token: tokenM2 })).body.length, 0);
    assert.equal(
      (await rawRequest(instanceA.baseUrl, `/api/tasks/${taskA.body.id}`, {
        method: 'DELETE',
        token: tokenM2
      })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, `/api/disciplines/${createDiscB.body.id}`, {
        method: 'DELETE',
        token: tokenM2
      })).status,
      404
    );

    // Reinicializacao do servidor e Pool preserva sessao valida
    await instanceA.close();
    await instanceB.close();
    instanceA = await startHttpServer(loadIsolatedServer({
      ...envCfg,
      RATE_LIMIT_LOGIN_MAX: '6',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '6'
    }));
    instanceB = await startHttpServer(loadIsolatedServer({
      ...envCfg,
      RATE_LIMIT_LOGIN_MAX: '6',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '6'
    }));

    const afterRestart = await rawRequest(instanceA.baseUrl, '/api/disciplines', { token });
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.length, 1);

    // Logout na instancia B revoga imediatamente tambem na instancia A
    const logoutRes = await rawRequest(instanceB.baseUrl, '/api/logout', { method: 'POST', token });
    assert.equal(logoutRes.status, 200);
    assert.equal((await rawRequest(instanceA.baseUrl, '/api/dashboard', { token })).status, 401);

    // Expiracao da sessao no PostgreSQL (TTL curto dedicado para evitar corrida sob carga)
    await instanceA.close();
    await instanceB.close();
    instanceA = await startHttpServer(loadIsolatedServer({
      ...envCfg,
      SESSION_TTL_MS: '1200'
    }));
    instanceB = await startHttpServer(loadIsolatedServer({
      ...envCfg,
      SESSION_TTL_MS: '1200'
    }));
    const loginShort = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'mariana2@pgsec.local', password: 'PgPassword!2026' }
    });
    assert.equal(loginShort.status, 200);
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await rawRequest(instanceB.baseUrl, '/api/dashboard', { token: loginShort.body.token })).status, 401);

    // Rate limiting atomico concorrente entre duas instancias no PostgreSQL + spoof X-Forwarded-For
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, idx) => {
        const target = idx % 2 === 0 ? instanceA.baseUrl : instanceB.baseUrl;
        return rawRequest(target, '/api/login', {
          method: 'POST',
          headers: { 'X-Forwarded-For': `198.51.100.${idx + 1}` },
          body: { email: 'mariana@pgsec.local', password: 'SenhaErrada!99' }
        });
      })
    );
    const denied = burst.filter(r => r.status === 429);
    assert.ok(denied.length >= 6, 'rajada concorrente multi-instancia deve sofrer bloqueio atomico 429');
    for (const r of denied) {
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
    }

    // Limpeza controlada de sessoes expiradas/revogadas e rate_limits expirados diretamente no PostgreSQL 17
    const cleanedSessions = await cleanupExpiredSessions(instanceA.db, {
      nowMs: Date.now() + 3600000,
      revokedGraceMs: 0
    });
    assert.ok(cleanedSessions >= 1);
    const cleanedRateLimits = await cleanupExpiredRateLimits(instanceA.db, {
      nowMs: Date.now() + 120000
    });
    assert.ok(cleanedRateLimits >= 1);
  } finally {
    await instanceA.close().catch(() => {});
    await instanceB.close().catch(() => {});
  }
});

test('PostgreSQL 17: rollback completo das migrations 004, 003, 002 e 001 e reaplicação limpa', async () => {
  const rbPool = new Pool({
    host: '127.0.0.1',
    port: cluster.port,
    user: 'postgres',
    database: 'organiza_sec_rb',
    ssl: false
  });

  try {
    await rbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
    `);

    await rbPool.query(m001);
    await rbPool.query(m002);
    await rbPool.query(m003);
    await rbPool.query(m004);

    const anonPrivs = await rbPool.query(`
      SELECT table_name
      FROM information_schema.table_privileges
      WHERE grantee IN ('anon', 'authenticated', 'PUBLIC')
        AND table_schema = 'public'
        AND table_name IN ('users', 'disciplines', 'tasks', 'sessions', 'rate_limits')
    `);
    assert.equal(anonPrivs.rows.length, 0);

    await rbPool.query(rb004);
    await rbPool.query(rb003);
    await rbPool.query(rb002);
    await rbPool.query(rb001);

    const left = await rbPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN ('users', 'disciplines', 'tasks', 'sessions', 'rate_limits')
    `);
    assert.equal(left.rows.length, 0);

    // Reaplica 001..004 para comprovar integridade idempotente
    await rbPool.query(m001);
    await rbPool.query(m002);
    await rbPool.query(m003);
    await rbPool.query(m004);
  } finally {
    await rbPool.end();
  }
});
