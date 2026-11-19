'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const { createPasswordManager, CryptoBusyError } = require(path.join(ROOT, 'backend', 'security', 'password'));
const {
  hashSessionToken,
  validateSession,
  cleanupExpiredSessions
} = require(path.join(ROOT, 'backend', 'security', 'session'));
const {
  getClientIp,
  cleanupExpiredRateLimits
} = require(path.join(ROOT, 'backend', 'security', 'rate-limit'));
const { CONTENT_SECURITY_POLICY } = require(path.join(ROOT, 'backend', 'security', 'headers'));

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

test('proteção de senhas: scrypt assíncrono gera hashes distintos, versionados e rejeita fora dos limites', async () => {
  const pm = createPasswordManager({});
  const h1 = await pm.hashPassword('SenhaForte#2026');
  const h2 = await pm.hashPassword('SenhaForte#2026');

  assert.notEqual(h1, h2, 'mesma senha deve gerar salts e hashes distintos');
  assert.match(h1, /^\$scrypt\$v=1\$N=32768,r=8,p=1\$[A-Za-z0-9_-]{22,}\$[A-Za-z0-9_-]{43,}$/);
  assert.equal(h1.includes('SenhaForte'), false);

  assert.equal(await pm.verifyPassword('SenhaForte#2026', h1), true);
  assert.equal(await pm.verifyPassword('SenhaForte#2026', h2), true);
  assert.equal(await pm.verifyPassword('SenhaErrada#2026', h1), false);

  // Rejeita hash SHA-256 legado e formatos corrompidos
  const legacySha = crypto.createHash('sha256').update('SenhaForte#2026').digest('hex');
  assert.equal(await pm.verifyPassword('SenhaForte#2026', legacySha), false);
  assert.equal(await pm.verifyPassword('SenhaForte#2026', '$scrypt$v=1$N=16,r=8,p=1$abc$def'), false);

  // Limite de tamanho
  assert.equal(pm.validatePasswordStrength('1234567').valid, false);
  assert.equal(pm.validatePasswordStrength('a'.repeat(129)).valid, false);
  assert.equal(pm.validatePasswordStrength('12345678').valid, true);
  await assert.rejects(() => pm.hashPassword('curta'), /entre 8 e 128/i);
});

test('limitação de concorrência criptográfica do scrypt protege fila sob rajada', async () => {
  const pm = createPasswordManager({
    SCRYPT_MAX_CONCURRENT: '1',
    SCRYPT_MAX_QUEUE: '1'
  });

  const attempts = await Promise.allSettled([
    pm.hashPassword('SenhaConcorrente1!'),
    pm.hashPassword('SenhaConcorrente2!'),
    pm.hashPassword('SenhaConcorrente3!'),
    pm.hashPassword('SenhaConcorrente4!')
  ]);

  const fulfilled = attempts.filter(r => r.status === 'fulfilled');
  const rejected = attempts.filter(r => r.status === 'rejected');
  assert.ok(fulfilled.length >= 2);
  assert.ok(rejected.length >= 1);
  for (const item of rejected) {
    assert.ok(item.reason instanceof CryptoBusyError);
    assert.equal(item.reason.status, 503);
  }
});

test('getClientIp ignora X-Forwarded-For quando TRUST_PROXY=false e respeita req.ip quando explicitado', () => {
  const fakeReq = {
    ip: '198.51.100.77',
    headers: { 'x-forwarded-for': '203.0.113.99' },
    socket: { remoteAddress: '::ffff:127.0.0.1' }
  };

  assert.equal(getClientIp(fakeReq, { trustProxy: false }), '127.0.0.1');
  assert.equal(getClientIp(fakeReq, { trustProxy: true }), '198.51.100.77');
});

test('frontend: HTML sem handlers inline, CSP compatível e validação sincronizada (8..128) em auth.js', async () => {
  for (const file of ['index.html', 'cadastro.html', 'dashboard.html', 'disciplinas.html', 'tarefas.html']) {
    const html = fs.readFileSync(path.join(ROOT, 'frontend', file), 'utf8');
    assert.doesNotMatch(html, /\sonclick\s*=/i, `${file} não deve conter onclick inline`);
    assert.doesNotMatch(html, /<style[\s>]/i, `${file} não deve conter <style> inline`);
  }

  const cadastroHtml = fs.readFileSync(path.join(ROOT, 'frontend', 'cadastro.html'), 'utf8');
  assert.match(cadastroHtml, /minlength="8"/);
  assert.match(cadastroHtml, /maxlength="128"/);

  assert.equal(CONTENT_SECURITY_POLICY.includes("'unsafe-inline'"), false);
  assert.match(CONTENT_SECURITY_POLICY, /script-src 'self'/);
  assert.match(CONTENT_SECURITY_POLICY, /frame-ancestors 'none'/);

  // Testa auth.js em sandbox garantindo rejeição local abaixo de 8 e acima de 128 caracteres
  const authSource = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'auth.js'), 'utf8');
  const listeners = new Map();
  const messageEl = { textContent: '', style: {}, setAttribute() {} };
  const registerForm = {
    addEventListener(name, fn) { listeners.set(name, fn); },
    querySelector() { return { disabled: false }; },
    reset() {}
  };
  let apiCalls = 0;
  const windowObj = {
    OrganizaAPI: {
      request: async () => { apiCalls += 1; return {}; },
      showMessage: (el, text) => { el.textContent = text; },
      saveSession: () => {}
    },
    location: { replace() {} }
  };
  const currentData = { name: 'Ana', email: 'ana@teste.local', password: '1234567' };
  vm.runInNewContext(authSource, {
    window: windowObj,
    document: {
      getElementById: (id) => id === 'registerForm' ? registerForm : id === 'message' ? messageEl : null
    },
    FormData: class { get(k) { return currentData[k]; } }
  });

  await listeners.get('submit')({ preventDefault() {} });
  assert.equal(apiCalls, 0);
  assert.match(messageEl.textContent, /entre 8 e 128/i);

  currentData.password = 'a'.repeat(129);
  await listeners.get('submit')({ preventDefault() {} });
  assert.equal(apiCalls, 0);

  // Testa binding [data-logout] no api.js
  const apiSource = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'api.js'), 'utf8');
  const docListeners = new Map();
  let storageValue = JSON.stringify({ token: 'tok', user: { id: 1 } });
  const apiWindow = { location: { replace() {} } };
  vm.runInNewContext(apiSource, {
    window: apiWindow,
    document: {
      addEventListener(name, fn) { docListeners.set(name, fn); }
    },
    sessionStorage: {
      getItem: () => storageValue,
      setItem: (_k, v) => { storageValue = v; },
      removeItem: () => { storageValue = null; }
    },
    fetch: async () => ({ ok: true, status: 200, text: async () => '{}' })
  });
  await docListeners.get('click')({ target: { closest: (sel) => sel === '[data-logout]' ? {} : null } });
  await new Promise(r => setImmediate(r));
  assert.equal(storageValue, null);
});

test('SQLite isolado: sessões multi-instância, expiração, logout, rate limit concorrente, validações, headers e rollback', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-sec-sqlite-'));
  const sqliteFile = path.join(tempDir, 'security.db');

  let instanceA = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: sqliteFile,
    SESSION_TTL_MS: '15000',
    RATE_LIMIT_LOGIN_MAX: '8',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: '8',
    RATE_LIMIT_REGISTER_MAX: '5',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_BLOCK_MS: '1500'
  }));
  let instanceB = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: sqliteFile,
    SESSION_TTL_MS: '15000',
    RATE_LIMIT_LOGIN_MAX: '8',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: '8',
    RATE_LIMIT_REGISTER_MAX: '5',
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_BLOCK_MS: '1500'
  }));

  try {
    // Senhas fora dos limites na API
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/register', {
        method: 'POST',
        body: { name: 'Ana', email: 'ana@sec.local', password: 'curta' }
      })).status,
      400
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/register', {
        method: 'POST',
        body: { name: 'Ana', email: 'ana@sec.local', password: 'x'.repeat(129) }
      })).status,
      400
    );

    // Cadastro valido e ausencia de senha em texto puro no banco
    const regA = await rawRequest(instanceA.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Ana', email: 'ana@sec.local', password: 'PasswordForte!1' }
    });
    assert.equal(regA.status, 201);

    const regB = await rawRequest(instanceA.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Bruno', email: 'bruno@sec.local', password: 'PasswordForte!2' }
    });
    assert.equal(regB.status, 201);

    const storedUser = await new Promise((resolve, reject) => {
      instanceA.db.get('SELECT id, password_hash FROM users WHERE email = ?', ['ana@sec.local'], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    assert.match(storedUser.password_hash, /^\$scrypt\$v=1\$/);
    assert.equal(storedUser.password_hash.includes('PasswordForte!1'), false);

    // Mensagem identica para conta inexistente vs senha errada
    const badMissing = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'naoexiste@sec.local', password: 'PasswordForte!1' }
    });
    const badWrong = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'ana@sec.local', password: 'SenhaErrada!999' }
    });
    assert.equal(badMissing.status, 401);
    assert.equal(badWrong.status, 401);
    assert.equal(badMissing.body.error, badWrong.body.error);

    // Login na instancia A -> token armazenado apenas como hash -> valido na instancia B
    const loginA = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'ana@sec.local', password: 'PasswordForte!1' }
    });
    assert.equal(loginA.status, 200);
    const tokenA = loginA.body.token;
    assert.ok(tokenA.length >= 43);

    const sessionRow = await new Promise((resolve, reject) => {
      instanceA.db.get('SELECT token_hash, revoked_at FROM sessions WHERE user_id = ?', [storedUser.id], (err, row) =>
        err ? reject(err) : resolve(row)
      );
    });
    assert.equal(sessionRow.token_hash, hashSessionToken(tokenA));
    assert.notEqual(sessionRow.token_hash, tokenA);
    assert.equal(sessionRow.revoked_at, null);

    // Instancia B reconhece a sessao criada na instancia A
    const dashFromB = await rawRequest(instanceB.baseUrl, '/api/dashboard', { token: tokenA });
    assert.equal(dashFromB.status, 200);

    // Cabecalhos HTTP de hardening + ausencia de CORS aberto e X-Powered-By
    assert.equal(dashFromB.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
    assert.equal(dashFromB.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(dashFromB.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(dashFromB.headers.get('x-frame-options'), 'DENY');
    assert.match(dashFromB.headers.get('cache-control'), /no-store/);
    assert.equal(dashFromB.headers.get('x-powered-by'), null);
    assert.equal(dashFromB.headers.get('access-control-allow-origin'), null);

    // Token adulterado rejeitado
    assert.equal(
      (await rawRequest(instanceB.baseUrl, '/api/dashboard', { token: `${tokenA.slice(0, -1)}Z` })).status,
      401
    );

    // Tentativa de SQL Injection no login e nos payloads nao vaza nem executa SQL arbitrario
    const sqliLogin = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: "' OR '1'='1", password: "' OR '1'='1" }
    });
    assert.equal(sqliLogin.status, 401);
    assert.equal(sqliLogin.body.error, badMissing.body.error);

    // Isolamento entre contas via API (Ana vs Bruno)
    const loginBruno = await rawRequest(instanceB.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'bruno@sec.local', password: 'PasswordForte!2' }
    });
    assert.equal(loginBruno.status, 200);
    const tokenBruno = loginBruno.body.token;

    const discAna = await rawRequest(instanceA.baseUrl, '/api/disciplines', {
      method: 'POST',
      token: tokenA,
      body: { name: "Engenharia ' OR 1=1 --" }
    });
    assert.equal(discAna.status, 201);

    // Spoof de user_id ignorado + validacoes de API + JSON 404 + 413 + JSON malformado
    const createdTask = await rawRequest(instanceB.baseUrl, '/api/tasks', {
      method: 'POST',
      token: tokenA,
      body: { title: 'Tarefa Segura', user_id: 9999, priority: 'Alta', due_date: '2026-12-10', discipline_id: discAna.body.id }
    });
    assert.equal(createdTask.status, 201);
    const taskOwner = await new Promise((resolve, reject) => {
      instanceB.db.get('SELECT user_id FROM tasks WHERE id = ?', [createdTask.body.id], (e, r) => e ? reject(e) : resolve(r));
    });
    assert.equal(taskOwner.user_id, storedUser.id);

    // Bruno nao consegue ver, vincular, editar, alterar status ou excluir recursos da Ana
    assert.equal((await rawRequest(instanceB.baseUrl, '/api/tasks', { token: tokenBruno })).body.length, 0);
    assert.equal((await rawRequest(instanceB.baseUrl, '/api/disciplines', { token: tokenBruno })).body.length, 0);
    assert.equal(
      (await rawRequest(instanceB.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenBruno,
        body: { title: 'Invasao', discipline_id: discAna.body.id }
      })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceB.baseUrl, `/api/tasks/${createdTask.body.id}`, {
        method: 'PUT',
        token: tokenBruno,
        body: { title: 'Alterada', priority: 'Alta' }
      })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceB.baseUrl, `/api/tasks/${createdTask.body.id}/status`, {
        method: 'PATCH',
        token: tokenBruno,
        body: { status: 'Concluída' }
      })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceB.baseUrl, `/api/tasks/${createdTask.body.id}`, {
        method: 'DELETE',
        token: tokenBruno
      })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceB.baseUrl, `/api/disciplines/${discAna.body.id}`, {
        method: 'DELETE',
        token: tokenBruno
      })).status,
      404
    );

    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenA,
        body: { title: 'Prioridade ruim', priority: 'Urgente' }
      })).status,
      400
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenA,
        body: { title: 'Data inexistente', due_date: '2026-02-30', priority: 'Média' }
      })).status,
      400
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/nao-existe', { token: tokenA })).status,
      404
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenA,
        rawBody: '{json_invalido'
      })).status,
      400
    );
    assert.equal(
      (await rawRequest(instanceA.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenA,
        body: { title: 'Grande', description: 'a'.repeat(20000) }
      })).status,
      413
    );

    // Reinicializacao completa do servidor preserva a sessao valida
    await instanceA.close();
    await instanceB.close();
    instanceA = await startHttpServer(loadIsolatedServer({
      NODE_ENV: 'test',
      DB_CLIENT: 'sqlite',
      SQLITE_DB_PATH: sqliteFile,
      SESSION_TTL_MS: '15000',
      RATE_LIMIT_LOGIN_MAX: '8',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '8',
      RATE_LIMIT_REGISTER_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_BLOCK_MS: '1500'
    }));

    const afterRestart = await rawRequest(instanceA.baseUrl, '/api/tasks', { token: tokenA });
    assert.equal(afterRestart.status, 200);
    assert.equal(afterRestart.body.length, 1);

    // Logout revoga e bloqueia reuso
    const logoutRes = await rawRequest(instanceA.baseUrl, '/api/logout', { method: 'POST', token: tokenA });
    assert.equal(logoutRes.status, 200);
    assert.equal((await rawRequest(instanceA.baseUrl, '/api/dashboard', { token: tokenA })).status, 401);

    // Expiracao da sessao e limpeza controlada (TTL curto dedicado para evitar corrida sob carga)
    await instanceA.close();
    instanceA = await startHttpServer(loadIsolatedServer({
      NODE_ENV: 'test',
      DB_CLIENT: 'sqlite',
      SQLITE_DB_PATH: sqliteFile,
      SESSION_TTL_MS: '1200',
      RATE_LIMIT_LOGIN_MAX: '8',
      RATE_LIMIT_LOGIN_ACCOUNT_MAX: '8',
      RATE_LIMIT_REGISTER_MAX: '2',
      RATE_LIMIT_WINDOW_MS: '60000',
      RATE_LIMIT_BLOCK_MS: '1500'
    }));
    const loginShort = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'bruno@sec.local', password: 'PasswordForte!2' }
    });
    assert.equal(loginShort.status, 200);
    const shortToken = loginShort.body.token;
    await new Promise(r => setTimeout(r, 1500));
    assert.equal((await rawRequest(instanceA.baseUrl, '/api/dashboard', { token: shortToken })).status, 401);
    assert.equal(await validateSession(instanceA.db, shortToken), null);

    // Rate limiting concorrente + X-Forwarded-For falso nao burla bloqueio
    const burst = await Promise.all(
      Array.from({ length: 10 }, (_, i) => rawRequest(instanceA.baseUrl, '/api/login', {
        method: 'POST',
        headers: { 'X-Forwarded-For': `203.0.113.${i + 10}` },
        body: { email: 'ana@sec.local', password: 'SenhaErrada!0' }
      }))
    );
    const blocked = burst.filter(r => r.status === 429);
    assert.ok(blocked.length >= 4, 'tentativas excedentes concorrentes devem receber HTTP 429');
    for (const r of blocked) {
      assert.ok(Number(r.headers.get('retry-after')) >= 1);
    }

    // Desbloqueio automatico apos blockMs e limpeza apos expiracao da janela
    await new Promise(r => setTimeout(r, 1700));
    const unblockedLogin = await rawRequest(instanceA.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'ana@sec.local', password: 'PasswordForte!1' }
    });
    assert.equal(unblockedLogin.status, 200);

    const cleanedRates = await cleanupExpiredRateLimits(instanceA.db, { nowMs: Date.now() + 70000 });
    assert.ok(cleanedRates >= 1);
    await cleanupExpiredSessions(instanceA.db, { revokedGraceMs: 0 });

    // Rollback das migrations SQLite e reaplicacao
    await instanceA.close();
    instanceA = null;
    const sqlite3 = require('sqlite3').verbose();
    const raw = new sqlite3.Database(sqliteFile);
    const rb002 = fs.readFileSync(path.join(ROOT, 'migrations', 'sqlite', 'rollback', '002_sessions_and_rate_limits_down.sql'), 'utf8');
    const rb001 = fs.readFileSync(path.join(ROOT, 'migrations', 'sqlite', 'rollback', '001_initial_schema_down.sql'), 'utf8');
    await new Promise((res, rej) => raw.exec(rb002 + '\n' + rb001, (err) => err ? rej(err) : res()));
    const tablesLeft = await new Promise((res, rej) =>
      raw.all("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'", (e, r) => e ? rej(e) : res(r))
    );
    assert.equal(tablesLeft.length, 0);
    await new Promise((res) => raw.close(res));
  } finally {
    if (instanceA) await instanceA.close().catch(() => {});
    if (instanceB) await instanceB.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
