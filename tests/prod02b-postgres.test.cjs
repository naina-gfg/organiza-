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
const { createDatabase } = require(path.join(ROOT, 'backend', 'db'));

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

async function apiJson(baseUrl, route, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

const pgBin = findPostgresBinDir();
assert.ok(pgBin, 'Binarios locais do PostgreSQL 17 nao encontrados para testes reais.');

const migration001 = fs.readFileSync(path.join(ROOT, 'migrations', '001_initial_schema.sql'), 'utf8');
const migration002 = fs.readFileSync(path.join(ROOT, 'migrations', '002_roles_and_rls.sql'), 'utf8');
const migration003 = fs.readFileSync(path.join(ROOT, 'migrations', '003_sessions_and_rate_limits.sql'), 'utf8');
const migration004 = fs.readFileSync(path.join(ROOT, 'migrations', '004_sessions_rls_and_grants.sql'), 'utf8');
const rollback002 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '002_roles_and_rls_down.sql'), 'utf8');
const rollback001 = fs.readFileSync(path.join(ROOT, 'migrations', 'rollback', '001_initial_schema_down.sql'), 'utf8');

let cluster = null;

async function setupEphemeralPostgres() {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-pg17-'));
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

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      await adminDefaultPool.query('SELECT 1');
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  await adminDefaultPool.query('CREATE DATABASE organiza_test');
  await adminDefaultPool.query('CREATE DATABASE organiza_rollback_test');

  const runtimePassword = crypto.randomBytes(18).toString('hex');

  const adminPool = new Pool({
    host: '127.0.0.1',
    port,
    user: 'postgres',
    database: 'organiza_test',
    ssl: false
  });

  await adminPool.query(migration001);
  await adminPool.query(migration002);
  await adminPool.query(migration003);
  await adminPool.query(migration004);
  await adminPool.query(`ALTER ROLE organiza_app WITH LOGIN PASSWORD '${runtimePassword}'`);

  const runtimeDatabaseUrl = `postgresql://organiza_app:${runtimePassword}@127.0.0.1:${port}/organiza_test`;

  return {
    baseDir,
    dataDir,
    port,
    proc,
    adminDefaultPool,
    adminPool,
    runtimePassword,
    runtimeDatabaseUrl,
    async stop() {
      await adminPool.end().catch(() => {});
      await adminDefaultPool.end().catch(() => {});
      try {
        execFileSync(path.join(pgBin, 'pg_ctl.exe'), ['-D', dataDir, 'stop', '-m', 'fast'], { stdio: 'ignore' });
      } catch {}
      if (!proc.killed) {
        await new Promise((resolve) => {
          proc.once('exit', resolve);
          setTimeout(() => {
            try { proc.kill(); } catch {}
            resolve();
          }, 2500);
        });
      }
      fs.rmSync(baseDir, { recursive: true, force: true });
    }
  };
}

test.before(async () => {
  cluster = await setupEphemeralPostgres();
});

test.after(async () => {
  if (cluster) {
    await cluster.stop();
  }
});

test('PostgreSQL 17: migration, role de privilégios mínimos (organiza_app), bloqueio público e RLS', async () => {
  // Verifica RLS ativo nas 3 tabelas
  const rlsStatus = await cluster.adminPool.query(`
    SELECT relname, relrowsecurity
    FROM pg_class
    WHERE relnamespace = 'public'::regnamespace
      AND relname IN ('users', 'disciplines', 'tasks')
    ORDER BY relname
  `);
  assert.deepEqual(rlsStatus.rows, [
    { relname: 'disciplines', relrowsecurity: true },
    { relname: 'tasks', relrowsecurity: true },
    { relname: 'users', relrowsecurity: true }
  ]);

  // Verifica que PUBLIC nao tem privilegios nem politicas
  const publicPrivs = await cluster.adminPool.query(`
    SELECT table_name, privilege_type
    FROM information_schema.table_privileges
    WHERE grantee = 'PUBLIC' AND table_schema = 'public'
      AND table_name IN ('users', 'disciplines', 'tasks')
  `);
  assert.equal(publicPrivs.rows.length, 0);

  const publicPolicies = await cluster.adminPool.query(`
    SELECT tablename, policyname, roles
    FROM pg_policies
    WHERE schemaname = 'public'
      AND ('public' = ANY(roles) OR 'anon' = ANY(roles) OR 'authenticated' = ANY(roles))
  `);
  assert.equal(publicPolicies.rows.length, 0);

  // Verifica atributos minimos da role de runtime organiza_app
  const roleAttrs = await cluster.adminPool.query(`
    SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit
    FROM pg_roles
    WHERE rolname = 'organiza_app'
  `);
  assert.deepEqual(roleAttrs.rows[0], {
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    rolbypassrls: false,
    rolinherit: false
  });

  // Conecta como role de runtime organiza_app e comprova bloqueios de privilegio minimo
  const runtimePool = new Pool({
    host: '127.0.0.1',
    port: cluster.port,
    user: 'organiza_app',
    password: cluster.runtimePassword,
    database: 'organiza_test',
    ssl: false
  });

  try {
    await assert.rejects(
      () => runtimePool.query('CREATE TABLE public.evil (id int)'),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => runtimePool.query('UPDATE public.users SET name = $1', ['X']),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => runtimePool.query('DELETE FROM public.users'),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => runtimePool.query('UPDATE public.disciplines SET name = $1', ['X']),
      (err) => err.code === '42501'
    );
    await assert.rejects(
      () => runtimePool.query('TRUNCATE public.tasks'),
      (err) => err.code === '42501'
    );
  } finally {
    await runtimePool.end();
  }
});

test('PostgreSQL 17: ciclo completo via organiza_app, integridade referencial no banco, tipos numéricos e reconexão', async () => {
  let runtime = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'postgres',
    DATABASE_URL: cluster.runtimeDatabaseUrl,
    DB_SSL: 'false'
  }));

  try {
    assert.equal(runtime.db.dialect, 'postgres');

    // Cadastro + erro 23505 de duplicidade de e-mail
    const regA = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Carla', email: 'carla@pg.local', password: 'pg-test-password-1' }
    });
    assert.equal(regA.status, 201);

    const regDup = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Carla Dup', email: 'CARLA@pg.local', password: 'pg-test-password-2' }
    });
    assert.equal(regDup.status, 409);

    const regB = await apiJson(runtime.baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Diego', email: 'diego@pg.local', password: 'pg-test-password-3' }
    });
    assert.equal(regB.status, 201);

    const loginA = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'carla@pg.local', password: 'pg-test-password-1' }
    });
    const loginB = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'diego@pg.local', password: 'pg-test-password-3' }
    });
    assert.equal(loginA.status, 200);
    assert.equal(loginB.status, 200);
    const tokenA = loginA.body.token;
    const tokenB = loginB.body.token;
    const userAId = loginA.body.user.id;

    // Dashboard vazio no PostgreSQL: garante numeros reais e zero NaN/null por bigint "0"
    const emptyDash = await apiJson(runtime.baseUrl, '/api/dashboard', { token: tokenA });
    assert.equal(emptyDash.status, 200);
    assert.deepEqual(emptyDash.body, { total: 0, completed: 0, pending: 0, productivity: 0, tasks: [] });
    for (const key of ['total', 'completed', 'pending', 'productivity']) {
      assert.equal(typeof emptyDash.body[key], 'number');
    }

    // Insercao e retorno de ID (RETURNING id)
    const discA = await apiJson(runtime.baseUrl, '/api/disciplines', {
      method: 'POST', token: tokenA, body: { name: 'Banco de Dados?' }
    });
    const discB = await apiJson(runtime.baseUrl, '/api/disciplines', {
      method: 'POST', token: tokenB, body: { name: 'Redes' }
    });
    assert.equal(discA.status, 201);
    assert.equal(typeof discA.body.id, 'number');
    assert.equal(discB.status, 201);

    // Protecao contra associacao de disciplina de outro usuario no banco (FK composta 23503)
    const pgDirect = createDatabase({
      NODE_ENV: 'test',
      DB_CLIENT: 'postgres',
      DATABASE_URL: cluster.runtimeDatabaseUrl,
      DB_SSL: 'false'
    });
    try {
      await assert.rejects(
        () => new Promise((resolve, reject) => {
          pgDirect.run(
            'INSERT INTO tasks (user_id, discipline_id, title) VALUES (?, ?, ?)',
            [userAId, discB.body.id, 'Associacao indevida no banco'],
            (err) => err ? reject(err) : resolve()
          );
        }),
        (err) => err.code === '23503'
      );

      // Tambem verifica db.run com literal contendo '?' e comentario contendo '?',
      // alem da assinatura de 2 argumentos (sql, cb) e this.changes em UPDATE
      const createdId = await new Promise((resolve, reject) => {
        pgDirect.run(
          "INSERT INTO tasks (user_id, discipline_id, title, description) VALUES (?, ?, ?, 'Qual prazo?') -- ?",
          [userAId, discA.body.id, 'Tarefa direta?'],
          function (err) {
            if (err) return reject(err);
            assert.equal(this.changes, 1);
            resolve(this.lastID);
          }
        );
      });
      assert.equal(typeof createdId, 'number');
      assert.ok(createdId > 0);

      const twoArgCount = await new Promise((resolve, reject) => {
        pgDirect.get('SELECT COUNT(*)::int AS total FROM tasks', (err, row) => {
          if (err) return reject(err);
          resolve(row);
        });
      });
      assert.equal(twoArgCount.total, 1);

      const zeroChanges = await new Promise((resolve, reject) => {
        pgDirect.run(
          'UPDATE tasks SET title = ? WHERE id = ? AND user_id = ?',
          ['Nao altera', createdId, userAId + 999],
          function (err) {
            if (err) return reject(err);
            resolve(this.changes);
          }
        );
      });
      assert.equal(zeroChanges, 0);
    } finally {
      await pgDirect.close();
    }

    // Teste de concorrencia entre validacao de disciplina e gravacao durante exclusao paralela
    const raceDisc = await apiJson(runtime.baseUrl, '/api/disciplines', {
      method: 'POST', token: tokenA, body: { name: 'Disciplina Concorrente' }
    });
    assert.equal(raceDisc.status, 201);

    const raceResults = await Promise.all([
      apiJson(runtime.baseUrl, `/api/disciplines/${raceDisc.body.id}`, {
        method: 'DELETE', token: tokenA
      }),
      ...Array.from({ length: 5 }, (_, idx) => apiJson(runtime.baseUrl, '/api/tasks', {
        method: 'POST',
        token: tokenA,
        body: {
          title: `Tarefa Corrida ${idx}`,
          discipline_id: raceDisc.body.id,
          priority: 'Média'
        }
      }))
    ]);

    assert.equal(raceResults[0].status, 200);
    for (const createRes of raceResults.slice(1)) {
      assert.ok(
        createRes.status === 201 || createRes.status === 404,
        `Status inesperado sob concorrencia: ${createRes.status}`
      );
      assert.notEqual(createRes.status, 500);
    }

    const tasksAfterRace = await apiJson(runtime.baseUrl, '/api/tasks', { token: tokenA });
    for (const task of tasksAfterRace.body) {
      if (task.title.startsWith('Tarefa Corrida')) {
        assert.equal(task.discipline_id, null);
        await apiJson(runtime.baseUrl, `/api/tasks/${task.id}`, { method: 'DELETE', token: tokenA });
      }
    }

    // Validacao de IDs invalidos sem 22P02 / 22003 (retorna 400)
    assert.equal((await apiJson(runtime.baseUrl, '/api/disciplines/abc', { method: 'DELETE', token: tokenA })).status, 400);
    assert.equal((await apiJson(runtime.baseUrl, '/api/tasks/abc/status', { method: 'PATCH', token: tokenA, body: { status: 'Concluída' } })).status, 400);
    assert.equal((await apiJson(runtime.baseUrl, '/api/tasks/9999999999', { method: 'DELETE', token: tokenA })).status, 400);

    // Excluir disciplina preserva tarefas com discipline_id = null via ON DELETE SET NULL (discipline_id)
    const delDisc = await apiJson(runtime.baseUrl, `/api/disciplines/${discA.body.id}`, {
      method: 'DELETE', token: tokenA
    });
    assert.equal(delDisc.status, 200);

    const tasksAfterDelete = await apiJson(runtime.baseUrl, '/api/tasks', { token: tokenA });
    assert.equal(tasksAfterDelete.status, 200);
    assert.equal(tasksAfterDelete.body.length, 1);
    assert.equal(tasksAfterDelete.body[0].discipline_id, null);
    assert.equal(tasksAfterDelete.body[0].discipline_name, null);
    assert.equal(tasksAfterDelete.body[0].description, 'Qual prazo?');

    // Testa RLS com app.current_user_id em transacao (e resiliencia a valor nao numerico)
    const client = await cluster.adminPool.connect();
    try {
      // Testa como organiza_app via SET ROLE no banco
      await client.query('BEGIN');
      await client.query('SET LOCAL ROLE organiza_app');
      await client.query("SELECT set_config('app.current_user_id', $1, true)", [String(userAId)]);
      const ownRows = await client.query('SELECT id FROM tasks');
      assert.equal(ownRows.rows.length, 1);

      await client.query("SELECT set_config('app.current_user_id', $1, true)", ['999999']);
      const otherRows = await client.query('SELECT id FROM tasks');
      assert.equal(otherRows.rows.length, 0);

      await client.query("SELECT set_config('app.current_user_id', $1, true)", ['invalido']);
      const invalidRows = await client.query('SELECT id FROM tasks');
      assert.equal(invalidRows.rows.length, 0);
      await client.query('ROLLBACK');
    } finally {
      client.release();
    }

    // Reconexao ao PostgreSQL comprova persistencia apos encerrar Pool e servidor
    await runtime.close();
    runtime = await startHttpServer(loadIsolatedServer({
      NODE_ENV: 'test',
      DB_CLIENT: 'postgres',
      DATABASE_URL: cluster.runtimeDatabaseUrl,
      DB_SSL: 'false'
    }));

    const relogin = await apiJson(runtime.baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'carla@pg.local', password: 'pg-test-password-1' }
    });
    assert.equal(relogin.status, 200);
    const dashReconnected = await apiJson(runtime.baseUrl, '/api/dashboard', { token: relogin.body.token });
    assert.equal(dashReconnected.status, 200);
    assert.equal(dashReconnected.body.total, 1);
    assert.equal(typeof dashReconnected.body.total, 'number');

    // Limpa os usuarios criados por este teste (tambem valida ON DELETE CASCADE em users -> disciplines/tasks sem conflito!)
    await cluster.adminPool.query('DELETE FROM users WHERE email IN ($1, $2)', ['carla@pg.local', 'diego@pg.local']);
  } finally {
    await runtime.close().catch(() => {});
  }
});

test('Equivalência completa SQLite × PostgreSQL: ordenação com prazos nulos, datas, tipos, edição, exclusão e dashboard', async () => {
  await cluster.adminPool.query('TRUNCATE TABLE rate_limits, sessions, tasks, disciplines, users RESTART IDENTITY CASCADE');

  const sqliteDir = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-equiv-sqlite-'));
  const sqliteFile = path.join(sqliteDir, 'equiv.db');

  const sqliteRuntime = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'sqlite',
    SQLITE_DB_PATH: sqliteFile
  }));

  const pgRuntime = await startHttpServer(loadIsolatedServer({
    NODE_ENV: 'test',
    DB_CLIENT: 'postgres',
    DATABASE_URL: cluster.runtimeDatabaseUrl,
    DB_SSL: 'false'
  }));

  async function runIdenticalScenario(baseUrl) {
    await apiJson(baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Equiv Um', email: 'equiv1@teste.local', password: 'equiv-password' }
    });
    await apiJson(baseUrl, '/api/register', {
      method: 'POST',
      body: { name: 'Equiv Dois', email: 'equiv2@teste.local', password: 'equiv-password' }
    });

    const u1 = (await apiJson(baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'equiv1@teste.local', password: 'equiv-password' }
    })).body.token;
    const u2 = (await apiJson(baseUrl, '/api/login', {
      method: 'POST',
      body: { email: 'equiv2@teste.local', password: 'equiv-password' }
    })).body.token;

    const dMat = (await apiJson(baseUrl, '/api/disciplines', {
      method: 'POST', token: u1, body: { name: 'Matemática' }
    })).body;
    const dAlg = (await apiJson(baseUrl, '/api/disciplines', {
      method: 'POST', token: u1, body: { name: 'Algoritmos' }
    })).body;
    const dOther = (await apiJson(baseUrl, '/api/disciplines', {
      method: 'POST', token: u2, body: { name: 'Outra Conta' }
    })).body;

    const emptyDash = await apiJson(baseUrl, '/api/dashboard', { token: u1 });

    // Sequencia pensada para testar todas as combinacoes de Ordem Atual e prazos nulos
    const createdIds = [];
    for (const payload of [
      { title: 'Pendente Alta 2026-12-31', discipline_id: dMat.id, due_date: '2026-12-31', priority: 'Alta', description: 'Fim do ano' },
      { title: 'Pendente Alta Sem Prazo A', discipline_id: dMat.id, due_date: null, priority: 'Alta', description: '' },
      { title: 'Pendente Alta 2026-06-15', discipline_id: dAlg.id, due_date: '2026-06-15', priority: 'Alta', description: 'Meio do ano' },
      { title: 'Pendente Media Sem Prazo', discipline_id: null, due_date: null, priority: 'Média', description: '' },
      { title: 'Pendente Media 2026-06-10', discipline_id: dAlg.id, due_date: '2026-06-10', priority: 'Média', description: '' },
      { title: 'Pendente Baixa Sem Prazo', discipline_id: null, due_date: null, priority: 'Baixa', description: '' },
      { title: 'Pendente Alta Sem Prazo B', discipline_id: dAlg.id, due_date: null, priority: 'Alta', description: '' }
    ]) {
      const r = await apiJson(baseUrl, '/api/tasks', { method: 'POST', token: u1, body: payload });
      assert.equal(r.status, 201);
      createdIds.push(r.body.id);
    }

    // Marca uma tarefa como Concluida e edita preservando status
    await apiJson(baseUrl, `/api/tasks/${createdIds[4]}/status`, {
      method: 'PATCH', token: u1, body: { status: 'Concluída' }
    });
    const putRes = await apiJson(baseUrl, `/api/tasks/${createdIds[4]}`, {
      method: 'PUT',
      token: u1,
      body: {
        title: 'Concluida Media Editada',
        description: 'Status deve permanecer Concluída',
        discipline_id: dAlg.id,
        due_date: '2026-06-09',
        priority: 'Média'
      }
    });

    // Rejeicao cruzada
    const crossPost = await apiJson(baseUrl, '/api/tasks', {
      method: 'POST', token: u1, body: { title: 'Bloqueada', discipline_id: dOther.id, priority: 'Alta' }
    });

    const disciplinesBefore = await apiJson(baseUrl, '/api/disciplines', { token: u1 });
    const tasksBefore = await apiJson(baseUrl, '/api/tasks', { token: u1 });
    const dashBefore = await apiJson(baseUrl, '/api/dashboard', { token: u1 });

    // Exclui disciplina com tarefas vinculadas (ON DELETE SET NULL)
    const deleteDisc = await apiJson(baseUrl, `/api/disciplines/${dMat.id}`, {
      method: 'DELETE', token: u1
    });

    const tasksAfter = await apiJson(baseUrl, '/api/tasks', { token: u1 });
    const dashAfter = await apiJson(baseUrl, '/api/dashboard', { token: u1 });

    const stripTimestamp = (rows) => rows.map(({ created_at, ...rest }) => rest);

    return {
      emptyDash,
      putRes,
      crossPost,
      deleteDisc,
      disciplinesBefore: {
        status: disciplinesBefore.status,
        body: stripTimestamp(disciplinesBefore.body)
      },
      tasksBefore: {
        status: tasksBefore.status,
        body: stripTimestamp(tasksBefore.body)
      },
      dashBefore,
      tasksAfter: {
        status: tasksAfter.status,
        body: stripTimestamp(tasksAfter.body)
      },
      dashAfter
    };
  }

  try {
    const sqliteResult = await runIdenticalScenario(sqliteRuntime.baseUrl);
    const pgResult = await runIdenticalScenario(pgRuntime.baseUrl);

    assert.deepEqual(pgResult, sqliteResult);

    // Confirma explicitamente a ordem "Ordem atual" esperada (NULLs antes das datas dentro do mesmo status/prioridade, determinismo de ID)
    assert.deepEqual(
      pgResult.tasksAfter.body.map(t => t.title),
      [
        'Pendente Alta Sem Prazo A',
        'Pendente Alta Sem Prazo B',
        'Pendente Alta 2026-06-15',
        'Pendente Alta 2026-12-31',
        'Pendente Media Sem Prazo',
        'Pendente Baixa Sem Prazo',
        'Concluida Media Editada'
      ]
    );
    assert.equal(pgResult.tasksAfter.body[3].due_date, '2026-12-31');
    assert.equal(pgResult.dashAfter.body.total, 7);
    assert.equal(pgResult.dashAfter.body.completed, 1);
    assert.equal(pgResult.dashAfter.body.pending, 6);
    assert.equal(pgResult.dashAfter.body.productivity, 14);
    assert.equal(typeof pgResult.dashAfter.body.total, 'number');
    assert.equal(typeof pgResult.dashAfter.body.completed, 'number');
    assert.equal(typeof pgResult.dashAfter.body.pending, 'number');
    assert.equal(typeof pgResult.dashAfter.body.productivity, 'number');
  } finally {
    await sqliteRuntime.close().catch(() => {});
    await pgRuntime.close().catch(() => {});
    fs.rmSync(sqliteDir, { recursive: true, force: true });
  }
});

test('PostgreSQL 17: scripts de rollback revertem migrations 002 e 001 sem erros e suportam reaplicação', async () => {
  const rbPool = new Pool({
    host: '127.0.0.1',
    port: cluster.port,
    user: 'postgres',
    database: 'organiza_rollback_test',
    ssl: false
  });

  try {
    // Simula roles da Data API do Supabase para testar revogacao na migration 002
    await rbPool.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$;
    `);

    await rbPool.query(migration001);
    await rbPool.query(migration002);

    const anonPrivs = await rbPool.query(`
      SELECT table_name, privilege_type
      FROM information_schema.table_privileges
      WHERE grantee IN ('anon', 'authenticated', 'PUBLIC') AND table_schema = 'public'
        AND table_name IN ('users', 'disciplines', 'tasks')
    `);
    assert.equal(anonPrivs.rows.length, 0);

    await rbPool.query(rollback002);
    await rbPool.query(rollback001);

    const remainingTables = await rbPool.query(`
      SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name IN ('users', 'disciplines', 'tasks')
    `);
    assert.equal(remainingTables.rows.length, 0);

    // Reaplica 001 e 002 apos rollback para provar idempotencia
    await rbPool.query(migration001);
    await rbPool.query(migration002);
  } finally {
    await rbPool.end();
  }
});
