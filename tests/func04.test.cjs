'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const taskUtils = require('../frontend/js/task-utils.js');

const ROOT = path.resolve(__dirname, '..');
const TODAY = '2026-06-15';
const serverSource = fs.readFileSync(path.join(ROOT, 'backend', 'server.js'), 'utf8');

function makeTasks() {
  return [
    { id: 1, title: 'Atrasada', status: 'Pendente', priority: 'Alta', discipline_id: 10, discipline_name: 'Dados', due_date: '2026-06-14', description: 'privada' },
    { id: 2, title: 'Hoje', status: 'Pendente', priority: 'Média', discipline_id: 10, discipline_name: 'Dados', due_date: TODAY, description: 'privada' },
    { id: 3, title: 'Amanhã', status: 'Pendente', priority: 'Baixa', discipline_id: 10, discipline_name: 'Dados', due_date: '2026-06-16', description: 'privada' },
    { id: 4, title: 'Limite sete dias', status: 'Pendente', priority: 'Alta', discipline_id: 20, discipline_name: 'Web', due_date: '2026-06-22', description: 'privada' },
    { id: 5, title: 'Oito dias', status: 'Pendente', priority: 'Alta', discipline_id: 20, discipline_name: 'Web', due_date: '2026-06-23', description: 'privada' },
    { id: 6, title: 'Concluída atrasada', status: 'Concluída', priority: 'Alta', discipline_id: 10, discipline_name: 'Dados', due_date: '2026-06-10', description: 'privada' },
    { id: 7, title: 'Data inválida', status: 'Pendente', priority: 'Média', discipline_id: null, discipline_name: null, due_date: '2026-02-30', description: 'privada' },
    { id: 8, title: 'Sem prazo', status: 'Pendente', priority: 'Baixa', discipline_id: null, discipline_name: null, due_date: null, description: 'privada' },
    { id: 9, title: 'Empate A', status: 'Pendente', priority: 'Média', discipline_id: 10, discipline_name: 'Dados', due_date: '2026-06-17', description: 'privada' },
    { id: 10, title: 'Empate B', status: 'Pendente', priority: 'Média', discipline_id: 20, discipline_name: 'Web', due_date: '2026-06-17', description: 'privada' },
    { id: 11, title: 'Entrega três dias', status: 'Pendente', priority: 'Baixa', discipline_id: 20, discipline_name: 'Web', due_date: '2026-06-18', description: 'privada' },
    { id: 12, title: 'Entrega quatro dias', status: 'Pendente', priority: 'Baixa', discipline_id: 10, discipline_name: 'Dados', due_date: '2026-06-19', description: 'privada' },
    { id: 13, title: 'Entrega cinco dias', status: 'Pendente', priority: 'Baixa', discipline_id: null, discipline_name: null, due_date: '2026-06-20', description: 'privada' },
    { id: 14, title: 'Concluída futura', status: 'Concluída', priority: 'Média', discipline_id: 20, discipline_name: 'Web', due_date: '2026-06-25', description: 'privada' }
  ];
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) return reject(error);
      resolve(this);
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => error ? reject(error) : resolve(row));
  });
}

async function createApiFixture() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE users (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE disciplines (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, name TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE tasks (
    id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, discipline_id INTEGER, title TEXT NOT NULL,
    description TEXT, due_date TEXT, priority TEXT DEFAULT 'Média', status TEXT DEFAULT 'Pendente'
  )`);

  const password = 'func04-isolated-test-password';
  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  await run(db, 'INSERT INTO users VALUES (?, ?, ?, ?)', [1, 'Conta Um', 'um@func04.local', passwordHash]);
  await run(db, 'INSERT INTO users VALUES (?, ?, ?, ?)', [2, 'Conta Dois', 'dois@func04.local', passwordHash]);
  await run(db, 'INSERT INTO users VALUES (?, ?, ?, ?)', [3, 'Conta Vazia', 'vazia@func04.local', passwordHash]);
  await run(db, 'INSERT INTO disciplines VALUES (?, ?, ?)', [11, 1, 'Dados Um']);
  await run(db, 'INSERT INTO disciplines VALUES (?, ?, ?)', [22, 2, 'Dados Dois']);
  await run(db, `INSERT INTO tasks
    (id, user_id, discipline_id, title, description, due_date, priority, status) VALUES
    (101, 1, 11, 'Pendente Um', 'não enviar esta descrição', '2026-06-14', 'Alta', 'Pendente'),
    (102, 1, NULL, 'Concluída Um', 'não enviar esta descrição', '2026-06-10', 'Média', 'Concluída'),
    (103, 1, NULL, 'Pendente sem disciplina', 'não enviar esta descrição', NULL, 'Baixa', 'Pendente'),
    (201, 2, 22, 'Tarefa Conta Dois', 'descrição da outra conta', '2026-06-15', 'Baixa', 'Pendente')`);

  let server;
  function isolatedExpress() {
    const app = express();
    const listen = app.listen;
    app.listen = function (...args) {
      server = listen.apply(this, args);
      return server;
    };
    return app;
  }
  isolatedExpress.json = express.json;
  isolatedExpress.static = express.static;
  const localRequire = name => name === 'express' ? isolatedExpress : name === './database' ? db : require(name);

  try {
    vm.runInNewContext(serverSource, {
      require: localRequire,
      __dirname: path.join(ROOT, 'backend'),
      console: { log() {}, error() {} },
      process: { env: { PORT: '0' } }
    }, { filename: 'backend/server.js' });

    await new Promise((resolve, reject) => {
      if (server?.listening) return resolve();
      if (!server) return reject(new Error('O servidor Express isolado não iniciou.'));
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    async function login(email) {
      const response = await fetch(`${baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password })
      });
      assert.equal(response.status, 200);
      return (await response.json()).token;
    }
    return {
      db,
      baseUrl,
      tokenOne: await login('um@func04.local'),
      tokenTwo: await login('dois@func04.local'),
      tokenThree: await login('vazia@func04.local'),
      async close() {
        await new Promise(resolve => server.close(resolve));
        await new Promise((resolve, reject) => db.close(error => error ? reject(error) : resolve()));
      }
    };
  } catch (error) {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => db.close(() => resolve()));
    throw error;
  }
}

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.className = '';
    this.hidden = false;
    this._textContent = '';
    this.unsafeHtmlAssignments = 0;
  }
  get textContent() {
    return [this._textContent, ...this.children.map(child => child.textContent)].filter(Boolean).join(' ');
  }
  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }
  set innerHTML(value) {
    this.unsafeHtmlAssignments += 1;
    this._innerHTML = String(value);
  }
  get innerHTML() { return this._innerHTML || ''; }
  appendChild(node) { this.children.push(node); return node; }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = [...nodes]; this._textContent = ''; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
}

function renderDashboard(response, options = {}) {
  const ids = [
    'welcome', 'total', 'pending', 'completed', 'productivity', 'progressBar', 'dashboardMessage',
    'overdue', 'dueToday', 'dueSoon', 'analyticsMessage', 'disciplineChart', 'disciplineEmpty',
    'statusSummary', 'statusPendingBar', 'statusCompletedBar', 'upcomingTasks', 'upcomingEmpty'
  ];
  const elements = Object.fromEntries(ids.map(id => [id, new FakeElement(id.includes('Bar') || id === 'progressBar' ? 'span' : 'div')]));
  for (const id of ['total', 'pending', 'completed', 'productivity', 'overdue', 'dueToday', 'dueSoon']) {
    elements[id].textContent = '—';
  }
  elements.dashboardMessage.textContent = 'Carregando indicadores...';
  elements.analyticsMessage.textContent = 'Carregando análises...';
  const calls = [];
  const redirects = [];
  const api = {
    readSession: () => options.session === false ? null : { token: 'test-token', user: { name: 'Conta <Um>' } },
    async request(endpoint, settings = {}) {
      calls.push({ endpoint, settings });
      if (options.error) throw new Error(options.error);
      return response;
    },
    showMessage(element, text, isError = false) {
      element.textContent = text;
      element.setAttribute('role', isError ? 'alert' : 'status');
      element.style.color = isError ? '#b42318' : '#18794e';
    }
  };
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tag => new FakeElement(tag)
  };
  const window = { OrganizaAPI: api, OrganizaTaskUtils: taskUtils, location: { replace: url => redirects.push(url) } };
  const fixedToday = new Date(`${TODAY}T12:00:00`);
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedToday])); }
  }
  const source = fs.readFileSync(path.join(ROOT, 'frontend', 'js', 'dashboard.js'), 'utf8');
  vm.runInNewContext(source, { window, document, Date: FixedDate }, { filename: 'frontend/js/dashboard.js' });
  return { elements, calls, redirects, async settled() { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); } };
}

test('deriva prazos, produtividade, grupos e cinco próximas entregas com datas controladas', () => {
  const tasks = makeTasks();
  const before = tasks.map(task => ({ ...task }));
  const result = taskUtils.deriveDashboardAnalytics(tasks, TODAY);

  assert.equal(result.total, 14);
  assert.equal(result.pending, 12);
  assert.equal(result.completed, 2);
  assert.equal(result.productivity, 14);
  assert.equal(result.overdue, 1);
  assert.equal(result.dueToday, 1);
  assert.equal(result.dueSoon, 7);
  assert.deepEqual(result.disciplines, [
    { disciplineId: 10, disciplineName: 'Dados', total: 6, pending: 5, completed: 1, percent: 43, pendingPercent: 83, completedPercent: 17 },
    { disciplineId: 20, disciplineName: 'Web', total: 5, pending: 4, completed: 1, percent: 36, pendingPercent: 80, completedPercent: 20 },
    { disciplineId: null, disciplineName: 'Sem disciplina', total: 3, pending: 3, completed: 0, percent: 21, pendingPercent: 100, completedPercent: 0 }
  ]);
  assert.deepEqual(result.statusSummary, [
    { status: 'Pendente', label: 'Pendentes', count: 12, percent: 86 },
    { status: 'Concluída', label: 'Concluídas', count: 2, percent: 14 }
  ]);
  assert.deepEqual(result.upcoming.map(task => task.id), [2, 3, 9, 10, 11]);
  assert.deepEqual(tasks, before, 'a derivação não deve mutar a lista de entrada');
});

test('retorna contagens e coleções vazias para usuário sem tarefas', () => {
  assert.deepEqual(taskUtils.deriveDashboardAnalytics([], TODAY), {
    total: 0, pending: 0, completed: 0, productivity: 0,
    overdue: 0, dueToday: 0, dueSoon: 0,
    disciplines: [],
    statusSummary: [
      { status: 'Pendente', label: 'Pendentes', count: 0, percent: 0 },
      { status: 'Concluída', label: 'Concluídas', count: 0, percent: 0 }
    ],
    upcoming: []
  });
});

test('GET /api/dashboard mantém as quatro métricas, projeta campos mínimos e isola usuários', async () => {
  const fixture = await createApiFixture();
  try {
    const unauthorized = await fetch(`${fixture.baseUrl}/api/dashboard`);
    assert.equal(unauthorized.status, 401);

    const oneResponse = await fetch(`${fixture.baseUrl}/api/dashboard`, {
      headers: { Authorization: `Bearer ${fixture.tokenOne}` }
    });
    assert.equal(oneResponse.status, 200);
    const one = await oneResponse.json();
    assert.deepEqual(Object.keys(one).sort(), ['completed', 'pending', 'productivity', 'tasks', 'total']);
    assert.deepEqual({ total: one.total, pending: one.pending, completed: one.completed, productivity: one.productivity }, {
      total: 3, pending: 2, completed: 1, productivity: 33
    });
    assert.deepEqual(one.tasks.map(task => task.id), [101, 103, 102]);
    assert.deepEqual(Object.keys(one.tasks[0]).sort(), [
      'discipline_id', 'discipline_name', 'due_date', 'id', 'priority', 'status', 'title'
    ]);
    assert.equal(one.tasks[0].discipline_name, 'Dados Um');
    assert.equal(one.tasks[1].discipline_id, null);
    assert.equal(one.tasks[1].discipline_name, null);
    assert.equal('description' in one.tasks[0], false);
    assert.equal(one.tasks.some(task => task.title === 'Tarefa Conta Dois'), false);

    const twoResponse = await fetch(`${fixture.baseUrl}/api/dashboard`, {
      headers: { Authorization: `Bearer ${fixture.tokenTwo}` }
    });
    const two = await twoResponse.json();
    assert.deepEqual(two.tasks.map(task => task.id), [201]);
    assert.equal(two.tasks[0].discipline_name, 'Dados Dois');

    const threeResponse = await fetch(`${fixture.baseUrl}/api/dashboard`, {
      headers: { Authorization: `Bearer ${fixture.tokenThree}` }
    });
    const three = await threeResponse.json();
    assert.equal(threeResponse.status, 200);
    assert.deepEqual({ total: three.total, pending: three.pending, completed: three.completed, productivity: three.productivity }, {
      total: 0, pending: 0, completed: 0, productivity: 0
    });
    assert.deepEqual(three.tasks, []);
    assert.equal((await get(fixture.db, 'SELECT COUNT(*) AS count FROM tasks')).count, 4, 'GET não deve gravar tarefas');
  } finally {
    await fixture.close();
  }
});

test('dashboard preserva os indicadores originais, usa texto seguro e não envia escrita', async () => {
  const tasks = makeTasks();
  tasks[1].title = '<img src=x onerror=alert(1)>';
  tasks[0].discipline_name = '<script>nome</script>';
  const fixture = renderDashboard({ total: 14, pending: 12, completed: 2, productivity: 14, tasks });
  await fixture.settled();

  assert.equal(fixture.elements.total.textContent, '14');
  assert.equal(fixture.elements.pending.textContent, '12');
  assert.equal(fixture.elements.completed.textContent, '2');
  assert.equal(fixture.elements.productivity.textContent, '14%');
  assert.equal(fixture.elements.progressBar.style.width, '14%');
  assert.equal(fixture.elements.overdue.textContent, '1');
  assert.equal(fixture.elements.dueToday.textContent, '1');
  assert.equal(fixture.elements.dueSoon.textContent, '7');
  assert.match(fixture.elements.upcomingTasks.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(fixture.elements.disciplineChart.textContent, /<script>nome<\/script>/);
  assert.equal(fixture.elements.upcomingTasks.unsafeHtmlAssignments, 0);
  assert.equal(fixture.elements.disciplineChart.unsafeHtmlAssignments, 0);
  assert.equal(fixture.elements.analyticsMessage.attributes['data-state'], 'success');
  assert.equal(fixture.calls.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(fixture.calls[0])), {
    endpoint: '/api/dashboard', settings: { protectedRoute: true }
  });
  assert.equal(fixture.calls.some(call => (call.settings.method || 'GET') !== 'GET'), false);
});

test('dashboard distingue ausência de tarefas e mantém zeros sem erro', async () => {
  const fixture = renderDashboard({ total: 0, pending: 0, completed: 0, productivity: 0, tasks: [] });
  await fixture.settled();

  assert.equal(fixture.elements.total.textContent, '0');
  assert.equal(fixture.elements.overdue.textContent, '0');
  assert.equal(fixture.elements.disciplineEmpty.hidden, false);
  assert.equal(fixture.elements.upcomingEmpty.hidden, false);
  assert.match(fixture.elements.analyticsMessage.textContent, /Nenhuma tarefa/);
  assert.equal(fixture.elements.analyticsMessage.attributes['data-state'], 'empty');
  assert.equal(fixture.elements.dashboardMessage.attributes.role, 'status');
});

test('dashboard distingue falha de API e não apresenta os placeholders como zeros', async () => {
  const fixture = renderDashboard(null, {
    error: 'Não foi possível conectar ao servidor. Verifique se o Node.js está em execução.'
  });
  await fixture.settled();

  assert.equal(fixture.elements.total.textContent, '—');
  assert.equal(fixture.elements.pending.textContent, '—');
  assert.equal(fixture.elements.analyticsMessage.attributes.role, 'alert');
  assert.equal(fixture.elements.analyticsMessage.attributes['data-state'], 'error');
  assert.match(fixture.elements.analyticsMessage.textContent, /Não foi possível carregar/);
  assert.equal(
    fixture.elements.dashboardMessage.textContent,
    'Não foi possível carregar o dashboard. Verifique sua conexão e tente novamente.'
  );
  assert.doesNotMatch(fixture.elements.dashboardMessage.textContent, /Node\.js/);
});

test('contrato antigo atualiza os quatro indicadores e não finge que faltam tarefas', async () => {
  const fixture = renderDashboard({ total: 4, pending: 3, completed: 1, productivity: 25 });
  await fixture.settled();

  assert.equal(fixture.elements.total.textContent, '4');
  assert.equal(fixture.elements.pending.textContent, '3');
  assert.equal(fixture.elements.completed.textContent, '1');
  assert.equal(fixture.elements.productivity.textContent, '25%');
  assert.equal(fixture.elements.overdue.textContent, '—');
  assert.match(fixture.elements.analyticsMessage.textContent, /indisponíveis/);
});

test('HTML inclui as novas regiões e carrega task-utils antes do dashboard', () => {
  const html = fs.readFileSync(path.join(ROOT, 'frontend', 'dashboard.html'), 'utf8');
  const css = fs.readFileSync(path.join(ROOT, 'frontend', 'css', 'style.css'), 'utf8');
  const taskUtilsIndex = html.indexOf('js/task-utils.js');
  const dashboardIndex = html.indexOf('js/dashboard.js');
  assert.ok(taskUtilsIndex >= 0 && dashboardIndex > taskUtilsIndex);
  for (const id of ['total', 'pending', 'completed', 'productivity', 'overdue', 'dueToday', 'dueSoon', 'disciplineChart', 'statusSummary', 'upcomingTasks']) {
    assert.match(html, new RegExp(`id="${id}"`), `HTML deve conter #${id}`);
  }
  assert.match(css, /#dashboardMessage,\s*#analyticsMessage\s*\{[^}]*color:\s*var\(--muted\)/s,
    'carregamento deve usar cor neutra');
  assert.match(css, /#analyticsMessage\[data-state="success"\]\s*\{[^}]*color:\s*var\(--success\)/s,
    'sucesso analítico deve usar verde');
  assert.match(css, /#analyticsMessage\[data-state="error"\]\s*\{[^}]*color:\s*var\(--danger\)/s,
    'erro analítico deve usar vermelho');
});

