'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createDatabase, resolveDatabaseConfig } = require(path.join(ROOT, 'backend', 'db'));
const { maskConnectionString, sanitizeErrorMessage } = require(path.join(ROOT, 'backend', 'db', 'config'));
const {
  translateSqlToPostgres,
  isUniqueConstraintError,
  isForeignKeyError
} = require(path.join(ROOT, 'backend', 'db', 'sql-compat'));

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
    const app = require(serverPath);
    return app;
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
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return {
    baseUrl,
    async close() {
      await new Promise((resolve) => server.close(resolve));
      if (app.db && typeof app.db.close === 'function') {
        await app.db.close();
      }
    }
  };
}

async function apiJson(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  const data = await response.json();
  return { status: response.status, body: data };
}

test('seleção do adaptador: SQLite local por padrão e PostgreSQL quando configurado', () => {
  const localDefault = resolveDatabaseConfig({ NODE_ENV: 'development' });
  assert.equal(localDefault.dialect, 'sqlite');
  assert.ok(localDefault.sqlite.filename.endsWith('plataforma.db'));

  const customSqlite = resolveDatabaseConfig({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: ':memory:',
    DATABASE_URL: 'postgresql://user:pass@localhost:5432/unused'
  });
  assert.equal(customSqlite.dialect, 'sqlite');
  assert.equal(customSqlite.sqlite.filename, ':memory:');

  const autoPostgres = resolveDatabaseConfig({
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://organiza_app:Secret%40123@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require'
  });
  assert.equal(autoPostgres.dialect, 'postgres');
  assert.equal(autoPostgres.postgres.poolConfig.host, 'aws-0-sa-east-1.pooler.supabase.com');
  assert.equal(autoPostgres.postgres.poolConfig.port, 6543);
  assert.equal(autoPostgres.postgres.poolConfig.user, 'organiza_app');
  assert.equal(autoPostgres.postgres.poolConfig.password, 'Secret@123');
  assert.equal(autoPostgres.postgres.poolConfig.max, 10);
  assert.equal(autoPostgres.postgres.poolConfig.idleTimeoutMillis, 10000);
  assert.equal(autoPostgres.postgres.poolConfig.connectionTimeoutMillis, 10000);
  assert.equal(autoPostgres.postgres.poolConfig.query_timeout, 15000);
  assert.deepEqual(autoPostgres.postgres.poolConfig.ssl, { rejectUnauthorized: true });

  const prodPostgres = resolveDatabaseConfig({
    NODE_ENV: 'production',
    DB_CLIENT: 'postgresql',
    DATABASE_URL: 'postgres://organiza_app:StrongPass@db.example.com:6543/postgres?sslmode=verify-full'
  });
  assert.equal(prodPostgres.dialect, 'postgres');
  assert.equal(prodPostgres.postgres.poolConfig.max, 5);
  assert.deepEqual(prodPostgres.postgres.poolConfig.ssl, { rejectUnauthorized: true });

  const localPgNoSsl = resolveDatabaseConfig({
    NODE_ENV: 'test',
    DATABASE_URL: 'postgresql://postgres@127.0.0.1:5432/postgres'
  });
  assert.equal(localPgNoSsl.dialect, 'postgres');
  assert.equal(localPgNoSsl.postgres.poolConfig.ssl, false);

  const caDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-ca-'));
  const caPath = path.join(caDir, 'ca.pem');
  fs.writeFileSync(caPath, '-----BEGIN CERTIFICATE-----\nTESTCA\n-----END CERTIFICATE-----\n');
  try {
    const prodWithCa = resolveDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://organiza_app:StrongPass@db.example.com:6543/postgres?sslmode=require',
      DB_SSL_CA_FILE: caPath
    });
    assert.equal(prodWithCa.postgres.poolConfig.ssl.rejectUnauthorized, true);
    assert.match(prodWithCa.postgres.poolConfig.ssl.ca, /BEGIN CERTIFICATE/);
  } finally {
    fs.rmSync(caDir, { recursive: true, force: true });
  }
});

test('falha segura quando faltar configuração de produção ou TLS for inseguro', () => {
  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: 'production' }),
    /Fallback silencioso para SQLite bloqueado/i
  );

  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: 'production', DB_CLIENT: 'sqlite' }),
    /SQLite nao e permitido em ambiente de producao/i
  );

  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: 'development', DB_CLIENT: 'postgres' }),
    /Fallback para SQLite bloqueado/i
  );

  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: 'development', DB_CLIENT: 'mysql' }),
    /DB_CLIENT invalido/i
  );

  assert.throws(
    () => resolveDatabaseConfig({ NODE_ENV: 'development', DATABASE_URL: '   ' }),
    /espacos em branco/i
  );

  const secret = 'SuperSecretPassword!99';
  assert.throws(
    () => resolveDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: `mysql://user:${secret}@example.com:3306/db`
    }),
    (err) => {
      assert.match(err.message, /protocolo deve ser postgres/i);
      assert.equal(err.message.includes(secret), false, 'não deve expor senha na exceção');
      return true;
    }
  );

  assert.throws(
    () => resolveDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://organiza_app:Secret@db.example.com:6543/postgres?sslmode=disable'
    }),
    /TLS nao pode ser desabilitado em producao/i
  );

  assert.throws(
    () => resolveDatabaseConfig({
      NODE_ENV: 'production',
      DATABASE_URL: 'postgresql://organiza_app:Secret@db.example.com:6543/postgres',
      DB_SSL_REJECT_UNAUTHORIZED: 'false'
    }),
    /validacao estrita de certificado TLS/i
  );
});

test('mascaramento de strings de conexão impede exposição em logs e mensagens', () => {
  const url = 'postgresql://organiza_app:MinhaSenhaSecreta!@aws-0-sa-east-1.pooler.supabase.com:6543/postgres?sslmode=require&password=abc';
  const masked = maskConnectionString(`Falha ao conectar em ${url}`);
  assert.equal(masked.includes('MinhaSenhaSecreta!'), false);
  assert.equal(masked.includes('password=abc'), false);
  assert.match(masked, /postgresql:\/\/\*\*\*:\*\*\*@aws-0-sa-east-1\.pooler\.supabase\.com:6543\/postgres/);

  const sanitized = sanitizeErrorMessage(new Error(`Error with ${url}`));
  assert.equal(sanitized.includes('MinhaSenhaSecreta!'), false);
});

test('tradutor SQL preserva literais, identificadores, dollar-quoting e comentários sem regex ingênua', () => {
  const complexSql = `
    -- comentario com interrogacao ?
    /* bloco /* aninhado ? */ ainda com ? */
    SELECT
      id,
      'O que fazer?''?' AS texto,
      E'escape \\'? aqui' AS texto_e,
      $$bloco dollar ? $$ AS texto_dollar,
      $tag$outro ? dollar$tag$ AS texto_tag,
      "col?" AS alias_quoted
    FROM tasks
    WHERE user_id = ? AND status = ? AND title <> 'teste?'
  `;
  const translated = translateSqlToPostgres(complexSql, { forRun: false });
  assert.equal(translated.placeholderCount, 2);
  assert.ok(translated.text.includes("'O que fazer?''?'"));
  assert.ok(translated.text.includes("E'escape \\'? aqui'"));
  assert.ok(translated.text.includes('$$bloco dollar ? $$'));
  assert.ok(translated.text.includes('$tag$outro ? dollar$tag$'));
  assert.ok(translated.text.includes('"col?"'));
  assert.ok(translated.text.includes('-- comentario com interrogacao ?'));
  assert.ok(translated.text.includes('/* bloco /* aninhado ? */ ainda com ? */'));
  assert.ok(translated.text.includes('WHERE user_id = $1 AND status = $2 AND title <> \'teste?\''));

  const insertSql = translateSqlToPostgres(
    "INSERT INTO tasks (user_id, title, description) VALUES (?, ?, 'Por quê?'); -- fim",
    { forRun: true }
  );
  assert.equal(insertSql.isInsert, true);
  assert.equal(insertSql.placeholderCount, 2);
  assert.equal(
    insertSql.text,
    "INSERT INTO tasks (user_id, title, description) VALUES ($1, $2, 'Por quê?') RETURNING id; -- fim"
  );

  const insertWithReturning = translateSqlToPostgres(
    'INSERT INTO users (name) VALUES (?) RETURNING id',
    { forRun: true }
  );
  assert.equal(insertWithReturning.text, 'INSERT INTO users (name) VALUES ($1) RETURNING id');

  assert.throws(
    () => translateSqlToPostgres('SELECT * FROM tasks WHERE user_id = ? AND id = $2'),
    /Mistura nao suportada/i
  );

  assert.equal(isUniqueConstraintError({ code: '23505', message: 'duplicate key value' }), true);
  assert.equal(isUniqueConstraintError({ message: 'SQLITE_CONSTRAINT: UNIQUE constraint failed' }), true);
  assert.equal(isForeignKeyError({ code: '23503' }), true);
  assert.equal(isForeignKeyError({ code: 'SQLITE_CONSTRAINT_TRIGGER', message: 'CROSS_USER_DISCIPLINE' }), true);
});

test('adaptador SQLite preserva contratos CRUD, integridade, datas, ordenação, tipos e persistência após reconexão', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-sqlite-'));
  const sqliteFile = path.join(tempDir, 'test.db');

  let runtime = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: sqliteFile
  }));

  try {
    // Cadastro e duplicidade de email
    const regA1 = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Ana', email: 'ANA@Teste.Local', password: 'segredo-teste-1' }
    });
    assert.equal(regA1.status, 201);

    const regDup = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Ana 2', email: 'ana@teste.local', password: 'segredo-teste-2' }
    });
    assert.equal(regDup.status, 409);

    const regB = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Bruno', email: 'bruno@teste.local', password: 'segredo-teste-3' }
    });
    assert.equal(regB.status, 201);

    const loginA = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'ana@teste.local', password: 'segredo-teste-1' }
    });
    assert.equal(loginA.status, 200);
    const tokenA = loginA.body.token;
    const userAId = loginA.body.user.id;

    const loginB = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'bruno@teste.local', password: 'segredo-teste-3' }
    });
    assert.equal(loginB.status, 200);
    const tokenB = loginB.body.token;

    // Dashboard vazio
    const emptyDash = await apiJson(runtime.baseUrl, '/api/dashboard', { token: tokenA });
    assert.equal(emptyDash.status, 200);
    assert.deepEqual(emptyDash.body, { total: 0, completed: 0, pending: 0, productivity: 0, tasks: [] });
    for (const key of ['total', 'completed', 'pending', 'productivity']) {
      assert.equal(typeof emptyDash.body[key], 'number');
    }

    // Criação de disciplinas e retorno de ID
    const discA = await apiJson(runtime.baseUrl, '/api/disciplines', {
      method: 'POST', token: tokenA, body: { name: 'Cálculo I' }
    });
    assert.equal(discA.status, 201);
    assert.equal(typeof discA.body.id, 'number');

    const discB = await apiJson(runtime.baseUrl, '/api/disciplines', {
      method: 'POST', token: tokenB, body: { name: 'Física II' }
    });
    assert.equal(discB.status, 201);

    // Tentativa de associar disciplina de outro usuário via API
    const crossTask = await apiJson(runtime.baseUrl, '/api/tasks', {
      method: 'POST',
      token: tokenA,
      body: { title: 'Invasão', discipline_id: discB.body.id, priority: 'Alta' }
    });
    assert.equal(crossTask.status, 404);

    // Proteção direta no banco SQLite (trigger + FK) contra associação cruzada
    await assert.rejects(
      () => new Promise((resolve, reject) => {
        runtime.baseUrl; // keep ref
        const dbDirect = createDatabase({ DB_CLIENT: 'sqlite', SQLITE_DB_PATH: sqliteFile });
        dbDirect.run(
          'INSERT INTO tasks (user_id, discipline_id, title) VALUES (?, ?, ?)',
          [userAId, discB.body.id, 'Bypass SQL'],
          (err) => dbDirect.close().then(() => err ? reject(err) : resolve())
        );
      }),
      (err) => isForeignKeyError(err)
    );

    // Inserção de tarefas com datas e prazos nulos para testar ordenação ("Ordem atual")
    const tNull = await apiJson(runtime.baseUrl, '/api/tasks', {
      method: 'POST',
      token: tokenA,
      body: { title: 'Alta sem prazo', discipline_id: discA.body.id, due_date: null, priority: 'Alta' }
    });
    const tLater = await apiJson(runtime.baseUrl, '/api/tasks', {
      method: 'POST',
      token: tokenA,
      body: { title: 'Alta distante', discipline_id: discA.body.id, due_date: '2026-12-31', priority: 'Alta' }
    });
    const tSooner = await apiJson(runtime.baseUrl, '/api/tasks', {
      method: 'POST',
      token: tokenA,
      body: { title: 'Alta próxima', discipline_id: discA.body.id, due_date: '2026-12-01', priority: 'Alta' }
    });
    assert.equal(tNull.status, 201);
    assert.equal(tLater.status, 201);
    assert.equal(tSooner.status, 201);

    // Edição preservando status e atualização de status via PATCH
    const patchRes = await apiJson(runtime.baseUrl, `/api/tasks/${tLater.body.id}/status`, {
      method: 'PATCH', token: tokenA, body: { status: 'Concluída' }
    });
    assert.equal(patchRes.status, 200);

    const putRes = await apiJson(runtime.baseUrl, `/api/tasks/${tLater.body.id}`, {
      method: 'PUT',
      token: tokenA,
      body: {
        title: 'Alta distante editada',
        description: 'Nova descrição',
        discipline_id: discA.body.id,
        due_date: '2026-12-30',
        priority: 'Alta'
      }
    });
    assert.equal(putRes.status, 200);

    // IDs inválidos retornam 400 e recursos de outra conta retornam 404
    assert.equal((await apiJson(runtime.baseUrl, '/api/disciplines/abc', { method: 'DELETE', token: tokenA })).status, 400);
    assert.equal((await apiJson(runtime.baseUrl, '/api/tasks/abc/status', { method: 'PATCH', token: tokenA, body: { status: 'Pendente' } })).status, 400);
    assert.equal((await apiJson(runtime.baseUrl, '/api/tasks/9999999999', { method: 'DELETE', token: tokenA })).status, 400);
    assert.equal((await apiJson(runtime.baseUrl, `/api/tasks/${tNull.body.id}`, { method: 'DELETE', token: tokenB })).status, 404);
    assert.equal((await apiJson(runtime.baseUrl, `/api/disciplines/${discA.body.id}`, { method: 'DELETE', token: tokenB })).status, 404);

    // Ordenação original preservada ("Ordem atual") e datas sem shift de fuso
    const listBeforeDelete = await apiJson(runtime.baseUrl, '/api/tasks', { token: tokenA });
    assert.equal(listBeforeDelete.status, 200);
    assert.deepEqual(
      listBeforeDelete.body.map(t => t.title),
      ['Alta sem prazo', 'Alta próxima', 'Alta distante editada']
    );
    assert.equal(listBeforeDelete.body[1].due_date, '2026-12-01');
    assert.equal(listBeforeDelete.body[2].due_date, '2026-12-30');
    assert.equal(listBeforeDelete.body[2].status, 'Concluída');

    // Exclusão de disciplina com tarefas vinculadas (ON DELETE SET NULL preserva tarefas)
    const delDisc = await apiJson(runtime.baseUrl, `/api/disciplines/${discA.body.id}`, {
      method: 'DELETE', token: tokenA
    });
    assert.equal(delDisc.status, 200);

    const dashFilled = await apiJson(runtime.baseUrl, '/api/dashboard', { token: tokenA });
    assert.equal(dashFilled.status, 200);
    assert.deepEqual(
      {
        total: dashFilled.body.total,
        completed: dashFilled.body.completed,
        pending: dashFilled.body.pending,
        productivity: dashFilled.body.productivity
      },
      { total: 3, completed: 1, pending: 2, productivity: 33 }
    );
    assert.equal(dashFilled.body.tasks.length, 3);
    assert.equal(dashFilled.body.tasks[0].discipline_id, null);
    assert.equal(dashFilled.body.tasks[0].discipline_name, null);

    // Reconexão ao mesmo banco SQLite e verificação de persistência
    await runtime.close();
    runtime = await startHttpServer(loadIsolatedServer({
      NODE_ENV: 'test',
      DB_CLIENT: 'sqlite',
      SQLITE_DB_PATH: sqliteFile
    }));

    const reloginA = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'ana@teste.local', password: 'segredo-teste-1' }
    });
    assert.equal(reloginA.status, 200);
    const dashAfterReconnect = await apiJson(runtime.baseUrl, '/api/dashboard', {
      token: reloginA.body.token
    });
    assert.equal(dashAfterReconnect.status, 200);
    assert.equal(dashAfterReconnect.body.total, 3);
    assert.deepEqual(
      dashAfterReconnect.body.tasks.map(t => t.title),
      ['Alta sem prazo', 'Alta próxima', 'Alta distante editada']
    );
  } finally {
    await runtime.close().catch(() => {});
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
