'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadAppWithMockDb(envOverrides = {}) {
  const originalEnv = { ...process.env };
  const keysToDelete = Object.keys(require.cache).filter((k) => k.includes(ROOT));
  for (const k of keysToDelete) {
    delete require.cache[k];
  }

  for (const [k, v] of Object.entries(envOverrides)) {
    if (v === undefined || v === null) delete process.env[k];
    else process.env[k] = String(v);
  }

  // Registra mock do database no require.cache antes de carregar o server
  const dbPath = path.join(ROOT, 'backend', 'database.js');
  require.cache[dbPath] = {
    id: dbPath,
    filename: dbPath,
    loaded: true,
    exports: {
      dialect: 'mock',
      get(sql, params, cb) { if (cb) cb(null, null); },
      all(sql, params, cb) { if (cb) cb(null, []); },
      run(sql, params, cb) { if (cb) cb.call({ lastID: 1, changes: 1 }, null); },
      close(cb) { if (cb) cb(null); }
    }
  };

  let loadedApp;
  try {
    loadedApp = require(path.join(ROOT, 'backend', 'server.js'));
  } finally {
    process.env = originalEnv;
  }
  return loadedApp;
}

async function startServer(app) {
  const server = await new Promise((resolve, reject) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
    s.once('error', reject);
  });
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close() {
      return new Promise((resolve) => server.close(resolve));
    }
  };
}

test('PROD-05-R1: Servimento estático em runtime Vercel real (VERCEL=1 + VERCEL_ENV=preview)', async (t) => {
  const app = loadAppWithMockDb({
    VERCEL: '1',
    VERCEL_ENV: 'preview',
    NODE_ENV: 'production'
  });
  const srv = await startServer(app);

  await t.test('GET / retorna 200 OK com index.html (elimina loop 302)', async () => {
    const res = await fetch(`${srv.baseUrl}/`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Organiza\+\s*\|\s*Login<\/title>/i);
  });

  await t.test('GET /index.html retorna 200 OK diretamente (sem redirect circular)', async () => {
    const res = await fetch(`${srv.baseUrl}/index.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="loginForm"/);
  });

  await t.test('GET /cadastro.html retorna 200 OK com formulário de cadastro', async () => {
    const res = await fetch(`${srv.baseUrl}/cadastro.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="registerForm"/);
  });

  await t.test('GET /dashboard.html retorna 200 OK no runtime real da Vercel', async () => {
    const res = await fetch(`${srv.baseUrl}/dashboard.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="welcome"/);
  });

  await t.test('GET /disciplinas.html retorna 200 OK', async () => {
    const res = await fetch(`${srv.baseUrl}/disciplinas.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="disciplineForm"/);
  });

  await t.test('GET /tarefas.html retorna 200 OK', async () => {
    const res = await fetch(`${srv.baseUrl}/tarefas.html`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /id="taskForm"/);
  });

  await t.test('GET /css/style.css retorna 200 OK com Content-Type text/css', async () => {
    const res = await fetch(`${srv.baseUrl}/css/style.css`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('text/css'));
  });

  await t.test('GET /js/api.js retorna 200 OK com Content-Type javascript', async () => {
    const res = await fetch(`${srv.baseUrl}/js/api.js`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const contentType = res.headers.get('content-type') || '';
    assert.ok(contentType.includes('javascript'));
  });

  await t.test('Fallback SPA: rota desconhecida /app/deep/link entrega index.html com 200 OK (sem loop 302)', async () => {
    const res = await fetch(`${srv.baseUrl}/app/deep/link`, { redirect: 'manual' });
    assert.equal(res.status, 200);
    const body = await res.text();
    assert.match(body, /<title>Organiza\+\s*\|\s*Login<\/title>/i);
  });

  await t.test('API 404 preservada: /api/desconhecida retorna 404 JSON', async () => {
    const res = await fetch(`${srv.baseUrl}/api/desconhecida`, { redirect: 'manual' });
    assert.equal(res.status, 404);
    const json = await res.json();
    assert.equal(json.error, 'Endpoint da API não encontrado.');
  });

  await srv.close();
});
