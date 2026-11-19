'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { Pool } = require('pg');

const ROOT = path.resolve(__dirname, '..');
const { ALLOWED_ASSETS, buildPublic } = require(path.join(ROOT, 'scripts', 'build-public.cjs'));
const { CONTENT_SECURITY_POLICY } = require(path.join(ROOT, 'backend', 'security', 'headers'));
const { resolveDatabaseConfig } = require(path.join(ROOT, 'backend', 'db', 'config'));
const { createPostgresAdapter } = require(path.join(ROOT, 'backend', 'db', 'postgres-adapter'));
const {
  MIN_PASSWORD_LENGTH,
  MAX_PASSWORD_LENGTH,
  SCRYPT_PARAMS,
  CryptoBusyError,
  createPasswordManager
} = require(path.join(ROOT, 'backend', 'security', 'password'));
const { scheduleBackgroundTask } = require(path.join(ROOT, 'backend', 'security', 'background'));
const { normalizeIp, resolveTrustProxy, getClientIp } = require(path.join(ROOT, 'backend', 'security', 'rate-limit'));

const EXPRESS_DETECT_REGEX = /(?:from|require|import)\s*(?:\(\s*)?["']express["']\s*(?:\))?/;

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listFilesRecursive(dir, baseDir = dir) {
  if (!fs.existsSync(dir)) return [];
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...listFilesRecursive(full, baseDir));
    } else if (entry.isFile()) {
      results.push(path.relative(baseDir, full).replace(/\\/g, '/'));
    }
  }
  return results.sort();
}

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

function findOpenSslBin() {
  const candidates = [
    'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    path.join(process.env.USERPROFILE || '', 'Tools', 'PostgreSQL17', 'pgsql', 'bin', 'openssl.exe')
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findBrowserBin() {
  const candidates = [
    process.env.BROWSER_BIN,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
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

function clearBackendRequireCache() {
  const targets = [
    path.join(ROOT, 'server.js'),
    path.join(ROOT, 'backend', 'server.js'),
    path.join(ROOT, 'backend', 'database.js'),
    path.join(ROOT, 'backend', 'db', 'index.js'),
    path.join(ROOT, 'backend', 'db', 'config.js'),
    path.join(ROOT, 'backend', 'db', 'postgres-adapter.js'),
    path.join(ROOT, 'backend', 'db', 'sqlite-adapter.js')
  ];
  for (const file of targets) {
    try {
      const resolved = require.resolve(file);
      delete require.cache[resolved];
    } catch {}
  }
}

function loadIsolatedEntrypoint(envOverrides, entryRelativePath = 'server.js') {
  const savedEnv = {};
  for (const [key, value] of Object.entries(envOverrides)) {
    savedEnv[key] = Object.prototype.hasOwnProperty.call(process.env, key)
      ? process.env[key]
      : undefined;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }

  clearBackendRequireCache();

  try {
    return require(path.join(ROOT, entryRelativePath));
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

async function rawRequest(baseUrl, route, { method = 'GET', token, body, headers: extraHeaders = {} } = {}) {
  const headers = { Accept: 'application/json', ...extraHeaders };
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: payload,
    redirect: 'manual'
  });
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: response.status, headers: response.headers, body: json, text };
}

function applyVercelConfigHeaders(vercelConfig, reqPath, res) {
  for (const rule of vercelConfig.headers || []) {
    const pattern = new RegExp(`^${rule.source.replace('(.*)', '.*')}$`);
    if (pattern.test(reqPath)) {
      for (const h of rule.headers || []) {
        res.setHeader(h.key, h.value);
      }
    }
  }
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

/**
 * Simula a topologia real da Vercel (CDN estatico servindo public/ com cabecalhos do vercel.json
 * na mesma origem da Function Express em /api/*).
 */
async function startVercelEdgeSimulator({ publicDir, vercelConfig, expressApp }) {
  const server = http.createServer((req, res) => {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/api' || urlPath.startsWith('/api/')) {
      applyVercelConfigHeaders(vercelConfig, urlPath, res);
      return expressApp(req, res);
    }

    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const safeResolved = path.resolve(publicDir, relative);
    if (!safeResolved.startsWith(path.resolve(publicDir))) {
      res.statusCode = 403;
      return res.end('Forbidden');
    }

    if (fs.existsSync(safeResolved) && fs.statSync(safeResolved).isFile()) {
      applyVercelConfigHeaders(vercelConfig, urlPath, res);
      const ext = path.extname(safeResolved).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      res.statusCode = 200;
      return fs.createReadStream(safeResolved).pipe(res);
    }

    return expressApp(req, res);
  });

  await new Promise((resolve, reject) => {
    server.listen(0, '127.0.0.1', () => resolve());
    server.once('error', reject);
  });

  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    async close() {
      await new Promise((resolve) => server.close(resolve));
    }
  };
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.listeners = new Map();
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timeout conectando ao DevTools CDP.')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`Falha WebSocket CDP: ${err.message || 'error'}`));
      });
    });

    this.ws.addEventListener('message', (event) => {
      const msg = JSON.parse(String(event.data));
      if (msg.id) {
        const entry = this.pending.get(msg.id);
        if (entry) {
          this.pending.delete(msg.id);
          if (msg.error) entry.reject(new Error(`CDP ${entry.method}: ${msg.error.message}`));
          else entry.resolve(msg.result);
        }
      } else if (msg.method) {
        this.events.push(msg);
        const list = this.listeners.get(msg.method);
        if (list) {
          for (const handler of list) handler(msg.params);
        }
      }
    });
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timeout no comando CDP ${method}`));
      }, 15000);
      this.pending.set(id, {
        method,
        resolve: (val) => { clearTimeout(timer); resolve(val); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true
    });
    if (res.exceptionDetails) {
      throw new Error(`Erro JS no navegador: ${JSON.stringify(res.exceptionDetails)}`);
    }
    return res.result ? res.result.value : undefined;
  }

  async close() {
    try {
      this.ws.close();
    } catch {}
  }
}

async function launchHeadlessBrowser(browserBin) {
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-cdp-'));
  const proc = spawn(
    browserBin,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--remote-debugging-port=0',
      `--user-data-dir=${userDataDir}`,
      'about:blank'
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let stderrBuf = '';
  const wsBrowserUrl = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Browser nao iniciou CDP a tempo. Stderr: ${stderrBuf}`)), 15000);
    proc.stderr.on('data', (chunk) => {
      stderrBuf += chunk.toString('utf8');
      const match = stderrBuf.match(/DevTools listening on (ws:\/\/[^\s]+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Browser encerrou prematuramente com codigo ${code}. Stderr: ${stderrBuf}`));
    });
  });

  const parsed = new URL(wsBrowserUrl);
  const targetsRes = await fetch(`http://${parsed.host}/json/list`);
  const targets = await targetsRes.json();
  const pageTarget = targets.find((t) => t.type === 'page') || targets[0];
  assert.ok(pageTarget && pageTarget.webSocketDebuggerUrl, 'Alvo de pagina DevTools nao encontrado.');

  const client = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await client.connect();
  await client.send('Page.enable');
  await client.send('Runtime.enable');

  return {
    client,
    async close() {
      await client.close();
      if (!proc.killed) {
        try { proc.kill(); } catch {}
        await new Promise((resolve) => {
          proc.once('exit', resolve);
          setTimeout(resolve, 2500);
        });
      }
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  };
}

async function waitForBrowserCondition(client, predicateExpr, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const ok = await client.evaluate(`Boolean(${predicateExpr})`);
    if (ok) return;
    await new Promise((r) => setTimeout(r, 80));
  }
  const snapshot = await client.evaluate('({ href: location.href, text: document.body ? document.body.innerText.slice(0, 300) : "" })');
  throw new Error(`Timeout aguardando condicao no navegador (${predicateExpr}). Estado: ${JSON.stringify(snapshot)}`);
}

const pgBin = findPostgresBinDir();
const opensslBin = findOpenSslBin();
const browserBin = findBrowserBin();

assert.ok(pgBin, 'Binarios locais do PostgreSQL 17 obrigatorios para testes de homologacao.');
assert.ok(opensslBin, 'OpenSSL local obrigatorio para testar TLS estrito do PostgreSQL.');
assert.ok(browserBin, 'Navegador Chromium/Edge local obrigatorio para teste E2E real com CSP.');

const m001 = fs.readFileSync(path.join(ROOT, 'migrations', '001_initial_schema.sql'), 'utf8');
const m002 = fs.readFileSync(path.join(ROOT, 'migrations', '002_roles_and_rls.sql'), 'utf8');
const m003 = fs.readFileSync(path.join(ROOT, 'migrations', '003_sessions_and_rate_limits.sql'), 'utf8');
const m004 = fs.readFileSync(path.join(ROOT, 'migrations', '004_sessions_rls_and_grants.sql'), 'utf8');
const m005 = fs.readFileSync(path.join(ROOT, 'migrations', '005_users_rehash_policy.sql'), 'utf8');
const rb005 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '005_users_rehash_policy_down.sql'), 'utf8');

let tlsCluster = null;

test.before(async () => {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-pg17-vercel-'));
  const dataDir = path.join(baseDir, 'data');

  execFileSync(
    path.join(pgBin, 'initdb.exe'),
    ['-D', dataDir, '-U', 'postgres', '--encoding=UTF8', '--auth=trust', '--no-instructions'],
    { stdio: 'pipe' }
  );

  const keyPath = path.join(dataDir, 'server.key');
  const certPath = path.join(dataDir, 'server.crt');
  execFileSync(
    opensslBin,
    [
      'req', '-new', '-x509', '-days', '7', '-nodes',
      '-newkey', 'rsa:2048',
      '-subj', '/CN=127.0.0.1',
      '-addext', 'subjectAltName=IP:127.0.0.1,DNS:localhost',
      '-keyout', keyPath,
      '-out', certPath
    ],
    { stdio: 'pipe' }
  );
  const certPem = fs.readFileSync(certPath, 'utf8');

  fs.appendFileSync(
    path.join(dataDir, 'postgresql.conf'),
    "\nssl = on\nssl_cert_file = 'server.crt'\nssl_key_file = 'server.key'\n",
    'utf8'
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
    ssl: { ca: certPem, rejectUnauthorized: true }
  });

  for (let i = 0; i < 60; i += 1) {
    try {
      await adminDefaultPool.query('SELECT 1');
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }

  await adminDefaultPool.query('CREATE DATABASE organiza_vercel_test');
  const runtimePassword = crypto.randomBytes(18).toString('hex');

  const adminPool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'organiza_vercel_test',
    ssl: { ca: certPem, rejectUnauthorized: true }
  });

  await adminPool.query(m001);
  await adminPool.query(m002);
  await adminPool.query(m003);
  await adminPool.query(m004);
  await adminPool.query(m005);
  await adminPool.query(`ALTER ROLE organiza_app WITH LOGIN PASSWORD '${runtimePassword}'`);

  tlsCluster = {
    baseDir,
    dataDir,
    port,
    proc,
    certPem,
    certPath,
    adminDefaultPool,
    adminPool,
    runtimePassword,
    runtimeDatabaseUrl: `postgresql://organiza_app:${runtimePassword}@127.0.0.1:${port}/organiza_vercel_test?sslmode=verify-full`
  };
});

test.after(async () => {
  if (!tlsCluster) return;
  await tlsCluster.adminPool.end().catch(() => {});
  await tlsCluster.adminDefaultPool.end().catch(() => {});
  try {
    execFileSync(path.join(pgBin, 'pg_ctl.exe'), ['-D', tlsCluster.dataDir, 'stop', '-m', 'fast'], { stdio: 'ignore' });
  } catch {}
  if (!tlsCluster.proc.killed) {
    await new Promise((resolve) => {
      tlsCluster.proc.once('exit', resolve);
      setTimeout(() => {
        try { tlsCluster.proc.kill(); } catch {}
        resolve();
      }, 2500);
    });
  }
  fs.rmSync(tlsCluster.baseDir, { recursive: true, force: true });
});

test('PROD-03 Config & Build: package.json, server.js, vercel.json, .vercelignore e public/ em paridade estrita', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.main, 'server.js');
  assert.equal(pkg.scripts.start, 'node backend/server.js');
  assert.equal(pkg.scripts.dev, 'node backend/server.js');
  assert.equal(pkg.scripts.build, 'node scripts/build-public.cjs');
  assert.equal(pkg.engines.node, '24.x');
  assert.ok(pkg.dependencies['@vercel/functions']);
  assert.ok(pkg.dependencies.express);
  assert.ok(pkg.dependencies.pg);
  assert.equal(pkg.dependencies.sqlite3, undefined);
  assert.ok(pkg.optionalDependencies.sqlite3);

  const rootEntrypointSource = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
  assert.match(rootEntrypointSource, EXPRESS_DETECT_REGEX);
  assert.match(rootEntrypointSource, /require\.main === module/);
  assert.match(rootEntrypointSource, /module\.exports = app/);

  const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  assert.equal(vercelConfig.framework, 'express');
  assert.equal(vercelConfig.buildCommand, 'npm run build');
  assert.equal(vercelConfig.outputDirectory, undefined, 'Nao deve definir outputDirectory com framework express');
  assert.equal(vercelConfig.fluid, true);
  assert.deepEqual(vercelConfig.regions, ['gru1']);
  assert.ok(vercelConfig.functions && vercelConfig.functions['server.js']);
  assert.equal(vercelConfig.functions['server.js'].maxDuration, 30);
  assert.equal(vercelConfig.functions['server.js'].memory, undefined);
  for (const excluded of ['tests/**', 'migrations/**', 'scripts/**', 'frontend/**', 'node_modules/sqlite3/**', '*.md', '*.db']) {
    assert.ok(vercelConfig.functions['server.js'].excludeFiles.includes(excluded));
  }

  const rootHeadersRule = vercelConfig.headers.find((h) => h.source === '/(.*)');
  assert.ok(rootHeadersRule);
  const rootHeadersMap = Object.fromEntries(rootHeadersRule.headers.map((h) => [h.key, h.value]));
  assert.equal(rootHeadersMap['Content-Security-Policy'], CONTENT_SECURITY_POLICY);
  assert.equal(rootHeadersMap['X-Content-Type-Options'], 'nosniff');
  assert.equal(rootHeadersMap['Referrer-Policy'], 'no-referrer');
  assert.equal(rootHeadersMap['X-Frame-Options'], 'DENY');
  assert.equal(rootHeadersMap['Cross-Origin-Opener-Policy'], 'same-origin');
  assert.equal(rootHeadersMap['Cross-Origin-Resource-Policy'], 'same-origin');
  assert.equal(rootHeadersMap['Permissions-Policy'], 'camera=(), microphone=(), geolocation=()');
  assert.equal(rootHeadersMap['Content-Security-Policy'].includes('unsafe-inline'), false);

  const apiHeadersRule = vercelConfig.headers.find((h) => h.source === '/api/(.*)');
  assert.ok(apiHeadersRule);
  const apiHeadersMap = Object.fromEntries(apiHeadersRule.headers.map((h) => [h.key, h.value]));
  assert.equal(apiHeadersMap['Cache-Control'], 'no-store, no-cache, must-revalidate, private');
  assert.equal(apiHeadersMap.Pragma, 'no-cache');
  assert.equal(apiHeadersMap.Expires, '0');

  const vercelIgnore = fs.readFileSync(path.join(ROOT, '.vercelignore'), 'utf8');
  for (const requiredIgnore of ['tests/', 'migrations/', '*.md', '*.db', 'public/', '.env', '.env.*', 'backend/plataforma.db']) {
    assert.ok(vercelIgnore.includes(requiredIgnore), `.vercelignore deve conter ${requiredIgnore}`);
  }

  // Testar build-public.cjs em workspace temporario contendo arquivos extras que nao devem vazar
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-build-'));
  try {
    fs.cpSync(path.join(ROOT, 'frontend'), path.join(tempRoot, 'frontend'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'frontend', 'segredo.env'), 'SECRET=1', 'utf8');
    fs.writeFileSync(path.join(tempRoot, 'frontend', 'dump.db'), 'sqlite', 'utf8');
    fs.mkdirSync(path.join(tempRoot, 'frontend', 'private'), { recursive: true });
    fs.writeFileSync(path.join(tempRoot, 'frontend', 'private', 'notes.md'), '# priv', 'utf8');

    const result = buildPublic({ rootDir: tempRoot });
    assert.equal(result.files.length, 12);
    assert.deepEqual(listFilesRecursive(result.outputDir), [...result.files].sort());
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  // Reexecutar build real e auditar public/ contra frontend/ por SHA-256
  const realBuild = buildPublic({ rootDir: ROOT });
  const publicFiles = listFilesRecursive(path.join(ROOT, 'public'));
  const expectedFiles = ALLOWED_ASSETS.map((p) => p.replace(/\\/g, '/')).sort();
  assert.deepEqual(publicFiles, expectedFiles);

  for (const rel of publicFiles) {
    assert.equal(
      sha256File(path.join(ROOT, 'public', rel)),
      sha256File(path.join(ROOT, 'frontend', rel)),
      `Paridade SHA-256 divergente em public/${rel}`
    );
  }
  assert.equal(realBuild.files.length, 12);

  // Build script portavel para Linux/POSIX (sem barras Windows fixas)
  const buildScriptSource = fs.readFileSync(path.join(ROOT, 'scripts', 'build-public.cjs'), 'utf8');
  assert.equal(/C:\\\\|C:\//i.test(buildScriptSource), false);
});

test('PROD-03 Entrypoint: server.js nao abre porta ao importar e inicia localmente com npm start / server.js', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-entry-'));
  try {
    const tempDb = path.join(tempDir, 'entry.sqlite');
    // 1. Verificar que require('./server.js') nao chama net.Server.prototype.listen
    const probeScript = `
      const http = require('node:http');
      let listenCount = 0;
      const origListen = http.Server.prototype.listen;
      http.Server.prototype.listen = function (...args) {
        listenCount += 1;
        return origListen.apply(this, args);
      };
      const app = require('./server.js');
      (async () => {
        if (typeof app !== 'function') throw new Error('app nao e funcao Express');
        if (listenCount !== 0) throw new Error('listen chamado ao importar server.js');
        if (app.db && typeof app.db.close === 'function') await app.db.close();
        process.stdout.write(JSON.stringify({ ok: true, listenCount, dialect: app.db.dialect }));
      })().catch((err) => { console.error(err); process.exit(1); });
    `;
    const importOut = execFileSync(process.execPath, ['-e', probeScript], {
      cwd: ROOT,
      env: { ...process.env, DB_CLIENT: 'sqlite', SQLITE_DB_PATH: tempDb, VERCEL: undefined, NODE_ENV: 'test' },
      encoding: 'utf8'
    });
    const parsed = JSON.parse(importOut);
    assert.deepEqual(parsed, { ok: true, listenCount: 0, dialect: 'sqlite' });

    // 2. Iniciar via `node server.js` e `node backend/server.js` e validar resposta HTTP real
    for (const entryScript of ['server.js', path.join('backend', 'server.js')]) {
      const port = await findFreePort();
      const child = spawn(process.execPath, [entryScript], {
        cwd: ROOT,
        env: {
          ...process.env,
          PORT: String(port),
          DB_CLIENT: 'sqlite',
          SQLITE_DB_PATH: tempDb,
          VERCEL: undefined,
          NODE_ENV: 'development'
        },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      try {
        let ready = false;
        for (let i = 0; i < 40; i += 1) {
          try {
            const pageCheck = await fetch(`http://127.0.0.1:${port}/index.html`);
            if (pageCheck.status === 200) {
              const html = await pageCheck.text();
              assert.match(html, /Organiza\+/);
              ready = true;
              break;
            }
          } catch {}
          await new Promise((r) => setTimeout(r, 100));
        }
        assert.ok(ready, `${entryScript} nao respondeu em /index.html`);

        const unauthRes = await fetch(`http://127.0.0.1:${port}/api/disciplines`);
        assert.equal(unauthRes.status, 401);
        const notFoundRes = await fetch(`http://127.0.0.1:${port}/api/nao-existe`);
        assert.equal(notFoundRes.status, 404);
        const notFoundJson = await notFoundRes.json();
        assert.equal(notFoundJson.error, 'Endpoint da API não encontrado.');
      } finally {
        child.kill();
        await new Promise((resolve) => {
          child.once('exit', resolve);
          setTimeout(resolve, 1500);
        });
      }
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PROD-03 Isolamento & Fail-Closed: VERCEL=1 bloqueia ausência de DATABASE_URL, SQLite e TLS frouxo, e carrega adapter PG preguiçosamente', () => {
  assert.throws(
    () => resolveDatabaseConfig({ VERCEL: '1', NODE_ENV: 'production' }),
    /DATABASE_URL obrigatoria|Fallback silencioso/i
  );
  assert.throws(
    () => resolveDatabaseConfig({ VERCEL: '1', DB_CLIENT: 'sqlite' }),
    /SQLite nao e permitido/i
  );
  assert.throws(
    () => resolveDatabaseConfig({ VERCEL: '1', DATABASE_URL: tlsCluster.runtimeDatabaseUrl, DB_SSL: 'false' }),
    /TLS nao pode ser desabilitado/i
  );
  assert.throws(
    () => resolveDatabaseConfig({ VERCEL: '1', DATABASE_URL: tlsCluster.runtimeDatabaseUrl, DB_SSL_REJECT_UNAUTHORIZED: 'false' }),
    /validacao estrita de certificado TLS/i
  );

  // Carregamento lazy: em VERCEL=1 com postgres, sqlite-adapter e sqlite3 nunca entram no require.cache
  const lazyProbe = `
    const { createDatabase } = require('./backend/db');
    const db = createDatabase(process.env);
    const loadedKeys = Object.keys(require.cache);
    const loadedSqliteAdapter = loadedKeys.some((k) => k.endsWith('sqlite-adapter.js'));
    const loadedSqliteDriver = loadedKeys.some((k) => k.includes('sqlite3'));
    Promise.resolve()
      .then(() => db.close())
      .then(() => {
        process.stdout.write(JSON.stringify({ dialect: db.dialect, loadedSqliteAdapter, loadedSqliteDriver }));
      })
      .catch((err) => { console.error(err); process.exit(1); });
  `;
  const lazyOut = execFileSync(process.execPath, ['-e', lazyProbe], {
    cwd: ROOT,
    env: {
      ...process.env,
      VERCEL: '1',
      NODE_ENV: 'production',
      DB_CLIENT: 'postgres',
      DATABASE_URL: tlsCluster.runtimeDatabaseUrl,
      DB_SSL_CA: tlsCluster.certPem
    },
    encoding: 'utf8'
  });
  assert.deepEqual(JSON.parse(lazyOut), {
    dialect: 'postgres',
    loadedSqliteAdapter: false,
    loadedSqliteDriver: false
  });
});

test('PROD-03 Integração @vercel/functions: attachDatabasePool e waitUntil invocados corretamente', async () => {
  // 1. Verifica chamada real de attachDatabasePool(pool) ao criar adaptador PostgreSQL
  const attachCalls = [];
  const originalVercelModule = require('@vercel/functions');
  const vercelResolved = require.resolve('@vercel/functions');
  const pgAdapterResolved = require.resolve(path.join(ROOT, 'backend', 'db', 'postgres-adapter.js'));

  const originalCachedVercel = require.cache[vercelResolved];
  try {
    require.cache[vercelResolved] = {
      id: vercelResolved,
      filename: vercelResolved,
      loaded: true,
      exports: {
        ...originalVercelModule,
        attachDatabasePool(pool) {
          attachCalls.push(pool);
          return originalVercelModule.attachDatabasePool(pool);
        },
        waitUntil(promise) {
          return originalVercelModule.waitUntil(promise);
        }
      }
    };
    delete require.cache[pgAdapterResolved];
    const { createPostgresAdapter: instrumentedCreatePg } = require(pgAdapterResolved);
    const cfg = resolveDatabaseConfig({
      VERCEL: '1',
      DATABASE_URL: tlsCluster.runtimeDatabaseUrl,
      DB_SSL_CA: tlsCluster.certPem
    });
    const adapter = instrumentedCreatePg(cfg.postgres, Pool);
    try {
      await adapter.ready();
      assert.equal(attachCalls.length, 1);
      assert.equal(attachCalls[0], adapter.pool);
      assert.equal(typeof adapter.pool.options.idleTimeoutMillis, 'number');
    } finally {
      await adapter.close();
    }
  } finally {
    if (originalCachedVercel) require.cache[vercelResolved] = originalCachedVercel;
    delete require.cache[pgAdapterResolved];
  }

  // 2. Verifica scheduleBackgroundTask chamando waitUntil de @vercel/functions com Promise
  const waitUntilCalls = [];
  const bgResolved = require.resolve(path.join(ROOT, 'backend', 'security', 'background.js'));
  try {
    require.cache[vercelResolved] = {
      id: vercelResolved,
      filename: vercelResolved,
      loaded: true,
      exports: {
        ...originalVercelModule,
        waitUntil(promise) {
          waitUntilCalls.push(promise);
          return originalVercelModule.waitUntil(promise);
        }
      }
    };
    delete require.cache[bgResolved];
    const { scheduleBackgroundTask: instrumentedBg } = require(bgResolved);

    let finished = false;
    const p1 = new Promise((resolve) => setTimeout(() => { finished = true; resolve('done'); }, 20));
    await instrumentedBg(p1);
    assert.equal(finished, true);
    assert.equal(waitUntilCalls.length, 1);

    // Promessa rejeitada nunca derruba o processo
    await instrumentedBg(Promise.reject(new Error('falha controlada')));
    assert.equal(waitUntilCalls.length, 2);
  } finally {
    if (originalCachedVercel) require.cache[vercelResolved] = originalCachedVercel;
    delete require.cache[bgResolved];
  }

  // Também garante que scheduleBackgroundTask fora de mock nao propaga rejeicao
  await assert.doesNotReject(() => scheduleBackgroundTask(Promise.reject(new Error('ignorado'))));
});

test('PROD-03 SEC-01 Scrypt & Rehash transparente (SQLite): N=32768, r=8, p=3, politica 15..128 e upgrade p=1 -> p=3', async () => {
  assert.equal(MIN_PASSWORD_LENGTH, 15);
  assert.equal(MAX_PASSWORD_LENGTH, 128);
  assert.deepEqual(SCRYPT_PARAMS, {
    N: 32768,
    r: 8,
    p: 3,
    keylen: 32,
    saltBytes: 16,
    maxmem: 64 * 1024 * 1024
  });

  const pm = createPasswordManager({ SCRYPT_MAX_CONCURRENT: '4', SCRYPT_MAX_QUEUE: '1' });
  assert.equal(pm.validatePasswordStrength('Curta@14chars!').valid, false);
  assert.equal(pm.validatePasswordStrength('ValidaCom15Char').valid, true);

  const hash = await pm.hashPassword('SenhaForte#2026!');
  assert.match(hash, /^\$scrypt\$v=1\$N=32768,r=8,p=3\$/);
  assert.equal(pm.needsRehash(hash), false);

  // Concorrencia de 4 operacoes simultaneas conclui + fila excedida lanca CryptoBusyError
  const busyCheck = await Promise.allSettled([
    pm.hashPassword('SenhaConcorrente1!'),
    pm.hashPassword('SenhaConcorrente2!'),
    pm.hashPassword('SenhaConcorrente3!'),
    pm.hashPassword('SenhaConcorrente4!'),
    pm.hashPassword('SenhaNaFilaUm12345'),
    pm.hashPassword('SenhaExcedeFila123')
  ]);
  const fulfilled = busyCheck.filter((r) => r.status === 'fulfilled');
  const rejected = busyCheck.filter((r) => r.status === 'rejected');
  assert.equal(fulfilled.length, 5);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reason instanceof CryptoBusyError);

  // Teste de rehash transparente p=1 -> p=3 em SQLite preservando senha legada <15 caracteres
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-rehash-sqlite-'));
  const sqliteFile = path.join(tempDir, 'rehash.sqlite');
  const app = loadIsolatedEntrypoint({
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: sqliteFile,
    NODE_ENV: 'test',
    VERCEL: undefined,
    TRUST_PROXY: 'false'
  });
  const srv = await startHttpServer(app);
  try {
    const legacyPassword = 'Legacy12Char';
    const legacySalt = crypto.randomBytes(16);
    const legacyDerived = await new Promise((resolve, reject) => {
      crypto.scrypt(legacyPassword, legacySalt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, key) => {
        if (err) reject(err);
        else resolve(key);
      });
    });
    const legacyHash = `$scrypt$v=1$N=32768,r=8,p=1$${legacySalt.toString('base64url')}$${legacyDerived.toString('base64url')}`;
    assert.equal(pm.needsRehash(legacyHash), true);

    await new Promise((resolve, reject) => {
      srv.db.run(
        'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
        ['Aluno Legado', 'legado@sqlite.local', legacyHash],
        (err) => (err ? reject(err) : resolve())
      );
    });

    const loginRes = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'legado@sqlite.local', password: legacyPassword }
    });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.body.token);

    const updatedUser = await new Promise((resolve, reject) => {
      srv.db.get(
        'SELECT password_hash FROM users WHERE email = ?',
        ['legado@sqlite.local'],
        (err, row) => (err ? reject(err) : resolve(row))
      );
    });
    assert.match(updatedUser.password_hash, /^\$scrypt\$v=1\$N=32768,r=8,p=3\$/);
    assert.notEqual(updatedUser.password_hash, legacyHash);

    // Login subsequente usando o hash atualizado funciona igualmente
    const secondLogin = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'legado@sqlite.local', password: legacyPassword }
    });
    assert.equal(secondLogin.status, 200);
  } finally {
    await srv.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('PROD-03 PostgreSQL 17 TLS + VERCEL=1: rehash p=1->p=3, grant/RLS minimo, 404 JSON, proxy IPv4/IPv6 e rate limit', async () => {
  // Verifica conexao TLS real no PG17
  const sslRow = await tlsCluster.adminPool.query('SELECT ssl FROM pg_stat_ssl WHERE pid = pg_backend_pid()');
  assert.equal(sslRow.rows[0].ssl, true);

  const app = loadIsolatedEntrypoint({
    VERCEL: '1',
    NODE_ENV: 'production',
    DB_CLIENT: 'postgres',
    DATABASE_URL: tlsCluster.runtimeDatabaseUrl,
    DB_SSL_CA: tlsCluster.certPem,
    RATE_LIMIT_WINDOW_MS: '60000',
    RATE_LIMIT_BLOCK_MS: '60000',
    RATE_LIMIT_LOGIN_MAX: '4',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: '50',
    RATE_LIMIT_REGISTER_MAX: '4'
  });
  const srv = await startHttpServer(app);
  try {
    // 1. Nao executa migrations automaticamente no boot e nao serve frontend/ com VERCEL=1
    const pageRedirect = await rawRequest(srv.baseUrl, '/dashboard.html');
    assert.equal(pageRedirect.status, 302);
    assert.equal(pageRedirect.headers.get('location'), '/index.html');

    // 2. JSON 404 para endpoint da API desconhecido com cabecalhos no-store
    const notFound = await rawRequest(srv.baseUrl, '/api/nao-existe');
    assert.equal(notFound.status, 404);
    assert.equal(notFound.body.error, 'Endpoint da API não encontrado.');
    assert.equal(notFound.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');
    assert.equal(notFound.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);

    // 3. Rota protegida da API sem sessao retorna 401 JSON em VERCEL=1 + PostgreSQL TLS
    const unauthApi = await rawRequest(srv.baseUrl, '/api/disciplines');
    assert.equal(unauthApi.status, 401);
    assert.equal(unauthApi.headers.get('cache-control'), 'no-store, no-cache, must-revalidate, private');

    // 4. Rehash transparente p=1 -> p=3 no PostgreSQL com migration 005
    const legacyPassword = 'PgLegacyPassword15!';
    const legacySalt = crypto.randomBytes(16);
    const legacyKey = await new Promise((resolve, reject) => {
      crypto.scrypt(legacyPassword, legacySalt, 32, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (err, k) => {
        if (err) reject(err);
        else resolve(k);
      });
    });
    const legacyHash = `$scrypt$v=1$N=32768,r=8,p=1$${legacySalt.toString('base64url')}$${legacyKey.toString('base64url')}`;

    await tlsCluster.adminPool.query(
      'INSERT INTO public.users (name, email, password_hash) VALUES ($1, $2, $3)',
      ['Aluno PG Legado', 'pg.rehash@academico.local', legacyHash]
    );

    const loginRes = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      headers: { 'x-vercel-forwarded-for': '198.51.100.10' },
      body: { email: 'pg.rehash@academico.local', password: legacyPassword }
    });
    assert.equal(loginRes.status, 200);
    assert.ok(loginRes.body.token);

    const authDisciplines = await rawRequest(srv.baseUrl, '/api/disciplines', {
      token: loginRes.body.token
    });
    assert.equal(authDisciplines.status, 200);
    assert.deepEqual(authDisciplines.body, []);

    const pgRow = await tlsCluster.adminPool.query(
      'SELECT id, password_hash FROM public.users WHERE email = $1',
      ['pg.rehash@academico.local']
    );
    assert.match(pgRow.rows[0].password_hash, /^\$scrypt\$v=1\$N=32768,r=8,p=3\$/);

    // Garantir que organiza_app continua proibido de alterar name ou email, ou alterar outro usuario com RLS ativo
    const runtimePool = new Pool({
      host: '127.0.0.1',
      port: tlsCluster.port,
      user: 'organiza_app',
      password: tlsCluster.runtimePassword,
      database: 'organiza_vercel_test',
      ssl: { ca: tlsCluster.certPem, rejectUnauthorized: true }
    });
    try {
      await assert.rejects(
        () => runtimePool.query("UPDATE public.users SET name = 'Alterado' WHERE id = $1", [pgRow.rows[0].id]),
        (e) => e.code === '42501'
      );
      await assert.rejects(
        () => runtimePool.query("UPDATE public.users SET email = 'x@y.com' WHERE id = $1", [pgRow.rows[0].id]),
        (e) => e.code === '42501'
      );
      const client = await runtimePool.connect();
      try {
        await client.query('BEGIN');
        await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(pgRow.rows[0].id + 999)]);
        const wrongUserUpdate = await client.query(
          'UPDATE public.users SET password_hash = $1 WHERE id = $2',
          [legacyHash, pgRow.rows[0].id]
        );
        assert.equal(wrongUserUpdate.rowCount, 0);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
    } finally {
      await runtimePool.end();
    }

    // 5. SEC-02 Proxy confiavel: cliente nao consegue burlar rate limit trocando X-Forwarded-For quando x-vercel-forwarded-for existe
    for (let i = 0; i < 4; i += 1) {
      const attempt = await rawRequest(srv.baseUrl, '/api/login', {
        method: 'POST',
        headers: {
          'x-vercel-forwarded-for': '203.0.113.77',
          'x-forwarded-for': `10.0.0.${i + 10}`
        },
        body: { email: 'naoexiste@academico.local', password: 'SenhaIncorreta#15' }
      });
      assert.equal(attempt.status, 401);
    }
    const blockedIpv4 = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      headers: {
        'x-vercel-forwarded-for': '203.0.113.77',
        'x-forwarded-for': '8.8.8.8'
      },
      body: { email: 'naoexiste@academico.local', password: 'SenhaIncorreta#15' }
    });
    assert.equal(blockedIpv4.status, 429);

    // Normalizacao IPv6 equivalente ([2001:db8::1]:1234 vs 2001:0db8:0:0:0:0:0:1) compartilha o mesmo contador
    for (let i = 0; i < 4; i += 1) {
      const attempt = await rawRequest(srv.baseUrl, '/api/login', {
        method: 'POST',
        headers: { 'x-vercel-forwarded-for': '[2001:db8:0:0:0:0:0:9]:44321' },
        body: { email: 'naoexiste6@academico.local', password: 'SenhaIncorreta#15' }
      });
      assert.equal(attempt.status, 401);
    }
    const blockedIpv6 = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      headers: { 'x-real-ip': '2001:0db8::9' },
      body: { email: 'naoexiste6@academico.local', password: 'SenhaIncorreta#15' }
    });
    assert.equal(blockedIpv6.status, 429);

    // Outra origem academica diferente segue operando normalmente
    const otherNetwork = await rawRequest(srv.baseUrl, '/api/login', {
      method: 'POST',
      headers: { 'x-vercel-forwarded-for': '203.0.113.88' },
      body: { email: 'naoexiste@academico.local', password: 'SenhaIncorreta#15' }
    });
    assert.equal(otherNetwork.status, 401);

    // 6. Testar utilitario de normalizacao e resolucao de proxy
    assert.equal(resolveTrustProxy({}), false);
    assert.equal(resolveTrustProxy({ VERCEL: '1' }), 'vercel');
    assert.throws(() => resolveTrustProxy({ TRUST_PROXY: 'true' }), /TRUST_PROXY=true/);
    assert.equal(normalizeIp('::ffff:192.0.2.15'), '192.0.2.15');
    assert.equal(normalizeIp('[2001:0db8:0000:0000:0000:0000:0000:0001]:8443'), '2001:db8::1');
    assert.equal(
      getClientIp({ headers: { 'x-forwarded-for': '8.8.8.8' }, socket: { remoteAddress: '127.0.0.1' } }, { trustProxy: false }),
      '127.0.0.1'
    );
  } finally {
    await srv.close();
  }
});

test('PROD-03 Navegador real (Chromium/Edge) + CDN public/ + VERCEL=1 API: fluxo academico completo e 0 violacoes CSP', async () => {
  const vercelConfig = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
  buildPublic({ rootDir: ROOT });

  const expressApp = loadIsolatedEntrypoint({
    VERCEL: '1',
    NODE_ENV: 'production',
    DB_CLIENT: 'postgres',
    DATABASE_URL: tlsCluster.runtimeDatabaseUrl,
    DB_SSL_CA: tlsCluster.certPem,
    RATE_LIMIT_LOGIN_MAX: '50',
    RATE_LIMIT_LOGIN_ACCOUNT_MAX: '50',
    RATE_LIMIT_REGISTER_MAX: '50'
  });

  const edge = await startVercelEdgeSimulator({
    publicDir: path.join(ROOT, 'public'),
    vercelConfig,
    expressApp
  });
  const browser = await launchHeadlessBrowser(browserBin);

  const consoleErrors = [];
  const pageExceptions = [];
  const cspViolations = [];
  let tokenFromSession = null;

  try {
    // 1. Verificar cabecalhos reais dos ativos estaticos e da API na mesma origem
    for (const staticPath of ['/index.html', '/cadastro.html', '/dashboard.html', '/css/style.css', '/js/dashboard.js']) {
      const res = await fetch(`${edge.baseUrl}${staticPath}`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-security-policy'), CONTENT_SECURITY_POLICY);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      assert.equal(res.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(res.headers.get('cross-origin-resource-policy'), 'same-origin');
    }

    const { client } = browser;
    client.on('Runtime.consoleAPICalled', (params) => {
      if (params.type === 'error') {
        const text = (params.args || []).map((a) => a.value || a.description || '').join(' ');
        consoleErrors.push(text);
      }
    });
    client.on('Runtime.exceptionThrown', (params) => {
      pageExceptions.push(params.exceptionDetails ? params.exceptionDetails.text : 'Exception');
    });

    await client.send('Runtime.addBinding', { name: '__reportCspViolation' });
    client.on('Runtime.bindingCalled', (params) => {
      if (params.name === '__reportCspViolation') {
        cspViolations.push(JSON.parse(params.payload));
      }
    });
    await client.send('Page.addScriptToEvaluateOnNewDocument', {
      source: `
        document.addEventListener('securitypolicyviolation', (ev) => {
          window.__reportCspViolation(JSON.stringify({
            directive: ev.violatedDirective,
            effectiveDirective: ev.effectiveDirective,
            blockedURI: ev.blockedURI,
            sourceFile: ev.sourceFile
          }));
        }, true);
      `
    });

    const uniqueEmail = `e2e.${Date.now()}@academico.local`;
    const userPass = 'OrganizaMais#2026!';

    // 2. Cadastro em cadastro.html (valida politica minima 15 caracteres + cria conta)
    await client.send('Page.navigate', { url: `${edge.baseUrl}/cadastro.html` });
    await waitForBrowserCondition(client, 'document.readyState === "complete" && Boolean(document.getElementById("registerForm"))');

    const minLengthAttr = await client.evaluate('document.querySelector("#registerForm input[name=password]").getAttribute("minlength")');
    assert.equal(minLengthAttr, '15');

    await client.evaluate(`
      document.querySelector('#registerForm input[name=name]').value = 'Estudante Vercel';
      document.querySelector('#registerForm input[name=email]').value = ${JSON.stringify(uniqueEmail)};
      document.querySelector('#registerForm input[name=password]').value = 'Curta14Chars!';
      document.querySelector('#registerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);
    await waitForBrowserCondition(client, 'document.getElementById("message").textContent.includes("entre 15 e 128")');

    await client.evaluate(`
      document.querySelector('#registerForm input[name=password]').value = ${JSON.stringify(userPass)};
      document.querySelector('#registerForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);
    await waitForBrowserCondition(client, 'document.getElementById("message").textContent.includes("Acesse a página de login")');

    // 3. Login em index.html -> redireciona para dashboard.html
    await client.send('Page.navigate', { url: `${edge.baseUrl}/index.html` });
    await waitForBrowserCondition(client, 'document.readyState === "complete" && Boolean(document.getElementById("loginForm"))');
    await client.evaluate(`
      document.querySelector('#loginForm input[name=email]').value = ${JSON.stringify(uniqueEmail)};
      document.querySelector('#loginForm input[name=password]').value = ${JSON.stringify(userPass)};
      document.querySelector('#loginForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);
    await waitForBrowserCondition(client, 'location.pathname.endsWith("/dashboard.html") && document.getElementById("welcome")?.textContent.includes("Estudante Vercel")');
    tokenFromSession = await client.evaluate('JSON.parse(sessionStorage.getItem("organiza_plus_session")).token');
    assert.ok(tokenFromSession);

    // 4. Disciplinas em disciplinas.html
    await client.send('Page.navigate', { url: `${edge.baseUrl}/disciplinas.html` });
    await waitForBrowserCondition(client, 'document.readyState === "complete" && Boolean(document.getElementById("disciplineForm"))');
    await client.evaluate(`
      document.querySelector('#disciplineForm input[name=name]').value = 'Sistemas Distribuidos';
      document.querySelector('#disciplineForm').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    `);
    await waitForBrowserCondition(client, 'document.getElementById("disciplineList").innerText.includes("Sistemas Distribuidos")');

    // 5. Tarefas em tarefas.html: criar duas tarefas, editar, filtrar e concluir
    await client.send('Page.navigate', { url: `${edge.baseUrl}/tarefas.html` });
    await waitForBrowserCondition(client, 'document.readyState === "complete" && document.querySelectorAll("#discipline_id option").length >= 2');

    const dueFuture = '2027-06-15';
    await client.evaluate(`(() => {
      const form = document.getElementById('taskForm');
      const discOption = Array.from(form.elements.namedItem('discipline_id').options).find(o => o.textContent.includes('Sistemas Distribuidos'));
      form.elements.namedItem('title').value = 'Seminario Vercel';
      form.elements.namedItem('description').value = 'Validar headers e Fluid Compute';
      form.elements.namedItem('discipline_id').value = discOption.value;
      form.elements.namedItem('due_date').value = ${JSON.stringify(dueFuture)};
      form.elements.namedItem('priority').value = 'Alta';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitForBrowserCondition(client, 'document.getElementById("taskList").innerText.includes("Seminario Vercel")');

    await client.evaluate(`(() => {
      const form = document.getElementById('taskForm');
      form.elements.namedItem('title').value = 'Revisao Postgres TLS';
      form.elements.namedItem('due_date').value = '2027-12-31';
      form.elements.namedItem('priority').value = 'Baixa';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitForBrowserCondition(client, 'document.getElementById("taskList").innerText.includes("Revisao Postgres TLS")');

    // Filtrar por prioridade Alta
    await client.evaluate(`(() => {
      const pf = document.getElementById('priorityFilter');
      pf.value = 'Alta';
      pf.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await waitForBrowserCondition(client, 'document.getElementById("taskSummary").textContent.includes("Exibindo 1 de 2")');

    // Editar e concluir tarefa filtrada
    await client.evaluate(`(() => {
      document.querySelector('#taskList .item button.btn-secondary').click();
    })()`);
    await waitForBrowserCondition(client, 'document.getElementById("taskFormTitle").textContent === "Editar tarefa"');
    await client.evaluate(`(() => {
      const form = document.getElementById('taskForm');
      form.elements.namedItem('title').value = 'Seminario Vercel Atualizado';
      form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    })()`);
    await waitForBrowserCondition(client, 'document.getElementById("taskList").innerText.includes("Seminario Vercel Atualizado")');

    await client.evaluate(`
      document.querySelector('#taskList .item button.btn-success').click();
    `);
    await waitForBrowserCondition(client, 'document.getElementById("message").textContent.includes("Status da tarefa atualizado")');

    await client.evaluate('document.getElementById("clearTaskFilters").click()');
    await waitForBrowserCondition(client, 'document.getElementById("taskSummary").textContent.includes("Exibindo 2 de 2") && document.getElementById("taskList").innerText.includes("Concluída")');

    // 6. Dashboard em dashboard.html: graficos dinamicos, barra de progresso e entregas sob CSP estrita
    await client.send('Page.navigate', { url: `${edge.baseUrl}/dashboard.html` });
    await waitForBrowserCondition(client, 'document.getElementById("total")?.textContent === "2" && document.getElementById("completed")?.textContent === "1"');
    const dashboardState = await client.evaluate(`({
      total: document.getElementById('total').textContent,
      completed: document.getElementById('completed').textContent,
      productivity: document.getElementById('productivity').textContent,
      progressWidth: document.getElementById('progressBar').style.width,
      chartRows: document.querySelectorAll('#disciplineChart .dashboard-chart-row').length,
      upcomingRows: document.querySelectorAll('#upcomingTasks li').length
    })`);
    assert.equal(dashboardState.total, '2');
    assert.equal(dashboardState.completed, '1');
    assert.equal(dashboardState.productivity, '50%');
    assert.equal(dashboardState.progressWidth, '50%');
    assert.equal(dashboardState.chartRows, 2);
    assert.ok(dashboardState.upcomingRows >= 1);

    // 7. Logout via [data-logout] limpa sessionStorage e revoga sessao no banco
    await client.evaluate('document.querySelector("[data-logout]").click()');
    await waitForBrowserCondition(client, 'location.pathname.endsWith("/index.html") && sessionStorage.getItem("organiza_plus_session") === null');

    const postLogoutMe = await rawRequest(edge.baseUrl, '/api/disciplines', { token: tokenFromSession });
    assert.equal(postLogoutMe.status, 401);

    assert.deepEqual(cspViolations, [], `Violacoes CSP detectadas no navegador: ${JSON.stringify(cspViolations)}`);
    assert.deepEqual(consoleErrors, [], `Erros de console detectados: ${JSON.stringify(consoleErrors)}`);
    assert.deepEqual(pageExceptions, [], `Excecoes nao tratadas na pagina: ${JSON.stringify(pageExceptions)}`);
  } finally {
    await browser.close();
    await edge.close();
    if (expressApp.db && typeof expressApp.db.close === 'function') {
      await expressApp.db.close();
    }
  }
});

test('PROD-03 Migration 005 rollback: revoga GRANT UPDATE (password_hash) e remove policy users_runtime_update', async () => {
  const rbPortDb = new Pool({
    host: '127.0.0.1',
    port: tlsCluster.port,
    user: 'postgres',
    database: 'postgres',
    ssl: { ca: tlsCluster.certPem, rejectUnauthorized: true }
  });
  await rbPortDb.query('CREATE DATABASE organiza_rb005');
  const targetPool = new Pool({
    host: '127.0.0.1',
    port: tlsCluster.port,
    user: 'postgres',
    database: 'organiza_rb005',
    ssl: { ca: tlsCluster.certPem, rejectUnauthorized: true }
  });
  try {
    await targetPool.query(m001);
    await targetPool.query(m002);
    await targetPool.query(m003);
    await targetPool.query(m004);
    await targetPool.query(m005);
    await targetPool.query(rb005);

    const colPriv = await targetPool.query(`
      SELECT privilege_type, column_name
      FROM information_schema.column_privileges
      WHERE grantee = 'organiza_app'
        AND table_schema = 'public'
        AND table_name = 'users'
        AND column_name = 'password_hash'
        AND privilege_type = 'UPDATE'
    `);
    assert.equal(colPriv.rows.length, 0);

    const policy = await targetPool.query(`
      SELECT policyname
      FROM pg_policies
      WHERE schemaname = 'public' AND tablename = 'users' AND policyname = 'users_runtime_update'
    `);
    assert.equal(policy.rows.length, 0);
  } finally {
    await targetPool.end();
    await rbPortDb.end();
  }
});
