'use strict';

// Integra a rota PUT real com Express e SQLite :memory:.
// O banco backend/plataforma.db nunca e aberto por esta suite.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const sqlite3 = require('sqlite3').verbose();
const express = require('express');
const taskUtils = require('../frontend/js/task-utils.js');

const root = path.resolve(__dirname, '..');
const serverSource = fs.readFileSync(
  path.join(root, 'backend', 'server.js'),
  'utf8'
);
const password = 'func02-isolated-test-password';

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
    db.get(sql, params, (error, row) => {
      if (error) return reject(error);
      resolve(row);
    });
  });
}

async function createFixture() {
  const db = new sqlite3.Database(':memory:');
  await run(db, `CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE disciplines (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL
  )`);
  await run(db, `CREATE TABLE tasks (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL,
    discipline_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    due_date TEXT,
    priority TEXT DEFAULT 'Média',
    status TEXT DEFAULT 'Pendente'
  )`);

  const passwordHash = crypto.createHash('sha256').update(password).digest('hex');
  await run(db, 'INSERT INTO users VALUES (?, ?, ?, ?)', [1, 'Teste Um', 'um@func02.local', passwordHash]);
  await run(db, 'INSERT INTO users VALUES (?, ?, ?, ?)', [2, 'Teste Dois', 'dois@func02.local', passwordHash]);
  await run(db, 'INSERT INTO disciplines VALUES (?, ?, ?)', [11, 1, 'Disciplina própria']);
  await run(db, 'INSERT INTO disciplines VALUES (?, ?, ?)', [22, 2, 'Disciplina de outra conta']);
  await run(db, `INSERT INTO tasks
    (id, user_id, discipline_id, title, description, due_date, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [101, 1, 11, 'Tarefa original', 'Descrição original', '2026-12-01', 'Média', 'Concluída']);
  await run(db, `INSERT INTO tasks
    (id, user_id, discipline_id, title, description, due_date, priority, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  [202, 2, 22, 'Tarefa de outra conta', '', null, 'Baixa', 'Pendente']);

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

  function localRequire(name) {
    if (name === 'express') return isolatedExpress;
    if (name === './database') return db;
    return require(name);
  }

  try {
    vm.runInNewContext(serverSource, {
      require: localRequire,
      __dirname: path.join(root, 'backend'),
      console: { log() {}, error() {} },
      process: { env: { PORT: '0' } }
    }, { filename: 'backend/server.js' });

    await new Promise((resolve, reject) => {
      if (server?.listening) return resolve();
      if (!server) return reject(new Error('O servidor Express de teste não iniciou.'));
      server.once('listening', resolve);
      server.once('error', reject);
    });

    const address = server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const loginResponse = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'um@func02.local', password })
    });
    assert.equal(loginResponse.status, 200, 'usuário de teste deve autenticar no servidor isolado');
    const { token } = await loginResponse.json();

    return {
      db,
      baseUrl,
      token,
      async requestTaskUpdate(id, body) {
        const response = await fetch(`${baseUrl}/api/tasks/${id}`, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify(body)
        });
        return { status: response.status, body: await response.json() };
      },
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

const validUpdate = {
  title: 'Tarefa revisada',
  description: 'Descrição revisada',
  discipline_id: 11,
  due_date: '2026-12-15',
  priority: 'Alta'
};

class FakeElement {
  constructor(tagName = 'div') {
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.listeners = new Map();
    this.attributes = {};
    this.style = {};
    this.disabled = false;
    this.hidden = false;
    this.value = '';
    this.className = '';
    this._textContent = '';
  }

  get textContent() {
    return [this._textContent, ...this.children.map(child => child.textContent)]
      .filter(Boolean)
      .join(' ');
  }

  set textContent(value) {
    this._textContent = String(value);
    this.children = [];
  }

  append(...nodes) { this.children.push(...nodes); }
  appendChild(node) { this.children.push(node); return node; }
  add(node) { this.children.push(node); }
  replaceChildren(...nodes) { this.children = [...nodes]; }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener(name, listener) {
    const listeners = this.listeners.get(name) || [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
  }
  async trigger(name, event = {}) {
    let result;
    for (const listener of this.listeners.get(name) || []) result = listener(event);
    return await result;
  }
  focus() {}
}

function createUiFixture(initialTasks = [{
  id: 101,
  title: 'Tarefa para editar',
  description: 'Descrição original',
  discipline_id: 11,
  discipline_name: 'Disciplina própria',
  due_date: '2026-12-20',
  priority: 'Média',
  status: 'Pendente'
}]) {
  const fieldDefaults = {
    title: '',
    description: '',
    discipline_id: '',
    due_date: '',
    priority: 'Média'
  };
  const fields = Object.fromEntries(Object.entries(fieldDefaults).map(([name, value]) => {
    const field = new FakeElement(
      name === 'description' ? 'textarea' :
        ['discipline_id', 'priority'].includes(name) ? 'select' : 'input'
    );
    field.name = name;
    field.value = value;
    return [name, field];
  }));
  const form = new FakeElement('form');
  form.elements = { namedItem: name => fields[name] };
  form.querySelector = selector => selector === 'button[type="submit"]' ? submit : null;
  form.reset = () => {
    for (const [name, value] of Object.entries(fieldDefaults)) fields[name].value = value;
  };
  const submit = new FakeElement('button');
  submit.textContent = 'Cadastrar tarefa';
  const cancelEdit = new FakeElement('button');
  cancelEdit.hidden = true;
  const formTitle = new FakeElement('h2');
  formTitle.textContent = 'Nova tarefa';
  const message = new FakeElement('p');
  const list = new FakeElement('div');
  const taskSummary = new FakeElement('p');
  const filters = {
    statusFilter: new FakeElement('select'),
    priorityFilter: new FakeElement('select'),
    disciplineFilter: new FakeElement('select'),
    dueDateFilter: new FakeElement('select'),
    taskSort: new FakeElement('select')
  };
  filters.statusFilter.value = 'all';
  filters.priorityFilter.value = 'all';
  filters.disciplineFilter.value = 'all';
  filters.dueDateFilter.value = 'all';
  filters.taskSort.value = 'current';
  const disciplineSelect = fields.discipline_id;
  const elements = {
    taskForm: form,
    taskList: list,
    taskSummary,
    message,
    discipline_id: disciplineSelect,
    cancelEdit,
    taskFormTitle: formTitle,
    clearTaskFilters: new FakeElement('button'),
    ...filters
  };
  const state = initialTasks.map(task => ({ ...task }));
  const requests = [];
  const api = {
    readSession: () => ({ token: 'isolated-test-token' }),
    async request(endpoint, options = {}) {
      requests.push({ endpoint, ...options });
      if (endpoint === '/api/disciplines') return [{ id: 11, name: 'Disciplina própria' }];
      if (endpoint === '/api/tasks' && (!options.method || options.method === 'GET')) {
        return state.map(task => ({ ...task }));
      }
      if (endpoint === '/api/tasks' && options.method === 'POST') {
        state.push({
          ...options.body,
          id: 303,
          status: 'Pendente',
          discipline_name: options.body.discipline_id ? 'Disciplina própria' : null
        });
        return { id: 303 };
      }
      const taskId = Number(endpoint.split('/')[3]);
      const taskIndex = state.findIndex(task => task.id === taskId);
      if (options.method === 'PUT') {
        if (taskIndex < 0) throw new Error('Tarefa não encontrada.');
        state[taskIndex] = {
          ...state[taskIndex],
          ...options.body,
          discipline_name: options.body.discipline_id ? 'Disciplina própria' : null
        };
        return { id: taskId };
      }
      if (options.method === 'PATCH') {
        state[taskIndex].status = options.body.status;
        return { message: 'Status atualizado.' };
      }
      if (options.method === 'DELETE') {
        state.splice(taskIndex, 1);
        return { message: 'Tarefa excluída.' };
      }
      throw new Error(`Requisição inesperada: ${options.method || 'GET'} ${endpoint}`);
    },
    showMessage(element, text, isError = false) {
      element.textContent = text;
      element.style.color = isError ? '#b42318' : '#18794e';
      element.setAttribute('role', 'status');
    }
  };
  const document = {
    getElementById: id => elements[id] || null,
    createElement: tagName => new FakeElement(tagName)
  };
  class FakeOption {
    constructor(text, value) {
      this.textContent = String(text);
      this.value = String(value);
    }
  }
  const window = {
    OrganizaAPI: api,
    OrganizaTaskUtils: taskUtils,
    confirm: () => true,
    location: { replace() {} }
  };
  const frontendSource = fs.readFileSync(
    path.join(root, 'frontend', 'js', 'tarefas.js'),
    'utf8'
  );
  vm.runInNewContext(frontendSource, {
    window,
    document,
    FormData: class {
      constructor() {}
      get(name) { return fields[name].value; }
    },
    Option: FakeOption,
    encodeURIComponent
  }, { filename: 'frontend/js/tarefas.js' });

  return {
    form,
    fields,
    list,
    message,
    submit,
    taskSummary,
    filters,
    cancelEdit,
    formTitle,
    state,
    requests,
    async ready() {
      for (let attempt = 0; attempt < 10; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
        if (list.children.length) return;
      }
      assert.fail('A lista de tarefas não foi renderizada.');
    }
  };
}

function actionButton(fixture, taskIndex, label) {
  const taskCard = fixture.list.children[taskIndex];
  assert.ok(taskCard, `tarefa de índice ${taskIndex} deve estar na lista`);
  const actions = taskCard.children.find(child => child.className === 'actions');
  assert.ok(actions, 'tarefa deve conter ações');
  const button = actions.children.find(child => child.textContent === label);
  assert.ok(button, `botão ${label} deve estar disponível`);
  return button;
}

test('frontend preenche os campos da tarefa e cancelar não envia PUT', async () => {
  const fixture = createUiFixture();
  await fixture.ready();

  await actionButton(fixture, 0, 'Editar').trigger('click');
  assert.equal(fixture.formTitle.textContent, 'Editar tarefa');
  assert.equal(fixture.submit.textContent, 'Salvar alterações');
  assert.equal(fixture.cancelEdit.hidden, false);
  assert.equal(fixture.fields.title.value, 'Tarefa para editar');
  assert.equal(fixture.fields.description.value, 'Descrição original');
  assert.equal(fixture.fields.discipline_id.value, '11');
  assert.equal(fixture.fields.due_date.value, '2026-12-20');
  assert.equal(fixture.fields.priority.value, 'Média');

  fixture.fields.title.value = 'Alteração descartada';
  await fixture.cancelEdit.trigger('click');

  assert.equal(fixture.formTitle.textContent, 'Nova tarefa');
  assert.equal(fixture.submit.textContent, 'Cadastrar tarefa');
  assert.equal(fixture.cancelEdit.hidden, true);
  assert.equal(fixture.fields.title.value, '');
  assert.equal(fixture.fields.priority.value, 'Média');
  assert.equal(fixture.requests.filter(request => request.method === 'PUT').length, 0);
  assert.equal(fixture.state[0].title, 'Tarefa para editar');
  assert.match(fixture.message.textContent, /Nenhuma alteração foi salva/);
});

test('frontend salva por PUT e atualiza a lista uma vez sem mudar o status', async () => {
  const fixture = createUiFixture();
  await fixture.ready();
  await actionButton(fixture, 0, 'Editar').trigger('click');

  fixture.fields.title.value = 'Tarefa atualizada na tela';
  fixture.fields.description.value = 'Nova descrição';
  fixture.fields.discipline_id.value = '11';
  fixture.fields.due_date.value = '2026-12-25';
  fixture.fields.priority.value = 'Alta';
  await fixture.form.trigger('submit', { preventDefault() {} });

  const put = fixture.requests.find(request => request.method === 'PUT');
  assert.ok(put);
  assert.equal(put.endpoint, '/api/tasks/101');
  assert.deepEqual(JSON.parse(JSON.stringify(put.body)), {
    title: 'Tarefa atualizada na tela',
    description: 'Nova descrição',
    discipline_id: 11,
    due_date: '2026-12-25',
    priority: 'Alta'
  });
  assert.equal(fixture.state.length, 1);
  assert.equal(fixture.state[0].id, 101);
  assert.equal(fixture.state[0].status, 'Pendente');
  assert.equal(fixture.list.children.length, 1);
  assert.match(fixture.list.textContent, /Tarefa atualizada na tela/);
  assert.equal(fixture.formTitle.textContent, 'Nova tarefa');
  assert.equal(fixture.submit.textContent, 'Cadastrar tarefa');
  assert.match(fixture.message.textContent, /Tarefa atualizada com sucesso/);
});

test('frontend mantém cadastro POST, conclusão, reabertura e exclusão', async () => {
  const fixture = createUiFixture();
  await fixture.ready();

  fixture.fields.title.value = 'Nova tarefa';
  await fixture.form.trigger('submit', { preventDefault() {} });
  assert.ok(fixture.requests.some(request => request.method === 'POST' && request.endpoint === '/api/tasks'));
  assert.equal(fixture.list.children.length, 2);

  await actionButton(fixture, 0, 'Concluir').trigger('click');
  assert.ok(fixture.requests.some(request => request.method === 'PATCH' && request.body.status === 'Concluída'));
  assert.ok(fixture.list.children.some(card => card.textContent.includes('Reabrir')));

  const completedIndex = fixture.state.findIndex(task => task.status === 'Concluída');
  await actionButton(fixture, completedIndex, 'Reabrir').trigger('click');
  assert.ok(fixture.requests.some(request => request.method === 'PATCH' && request.body.status === 'Pendente'));

  await actionButton(fixture, 0, 'Excluir').trigger('click');
  assert.ok(fixture.requests.some(request => request.method === 'DELETE'));
  assert.equal(fixture.list.children.length, 1);
});

test('PUT atualiza os campos permitidos e preserva ID, status e quantidade de tarefas', async () => {
  const fixture = await createFixture();
  try {
    const response = await fixture.requestTaskUpdate(101, validUpdate);
    assert.equal(response.status, 200);
    assert.equal(response.body.id, 101);

    const task = await get(fixture.db, 'SELECT * FROM tasks WHERE id = ?', [101]);
    assert.deepEqual({
      id: task.id,
      user_id: task.user_id,
      discipline_id: task.discipline_id,
      title: task.title,
      description: task.description,
      due_date: task.due_date,
      priority: task.priority,
      status: task.status
    }, {
      id: 101,
      user_id: 1,
      discipline_id: 11,
      title: validUpdate.title,
      description: validUpdate.description,
      due_date: validUpdate.due_date,
      priority: validUpdate.priority,
      status: 'Concluída'
    });
    const count = await get(fixture.db, 'SELECT COUNT(*) AS total FROM tasks');
    assert.equal(count.total, 2);
  } finally {
    await fixture.close();
  }
});

test('PUT não permite editar tarefa pertencente a outro usuário', async () => {
  const fixture = await createFixture();
  try {
    const response = await fixture.requestTaskUpdate(202, validUpdate);
    assert.equal(response.status, 404);
    const task = await get(fixture.db, 'SELECT title, status FROM tasks WHERE id = ?', [202]);
    assert.deepEqual(task, { title: 'Tarefa de outra conta', status: 'Pendente' });
  } finally {
    await fixture.close();
  }
});

test('PUT rejeita disciplina de outra conta sem alterar a tarefa', async () => {
  const fixture = await createFixture();
  try {
    const response = await fixture.requestTaskUpdate(101, { ...validUpdate, discipline_id: 22 });
    assert.equal(response.status, 404);
    const task = await get(fixture.db, 'SELECT discipline_id, title, status FROM tasks WHERE id = ?', [101]);
    assert.deepEqual(task, { discipline_id: 11, title: 'Tarefa original', status: 'Concluída' });
  } finally {
    await fixture.close();
  }
});

test('PUT rejeita campos inválidos sem persistir alterações', async () => {
  const fixture = await createFixture();
  try {
    const invalidBodies = [
      { ...validUpdate, title: '   ' },
      { ...validUpdate, priority: 'Urgente' },
      { ...validUpdate, due_date: '2026-02-30' },
      { ...validUpdate, discipline_id: -1 }
    ];

    for (const body of invalidBodies) {
      const response = await fixture.requestTaskUpdate(101, body);
      assert.equal(response.status, 400);
    }

    const task = await get(fixture.db, 'SELECT title, description, due_date, priority, status FROM tasks WHERE id = ?', [101]);
    assert.deepEqual(task, {
      title: 'Tarefa original',
      description: 'Descrição original',
      due_date: '2026-12-01',
      priority: 'Média',
      status: 'Concluída'
    });
  } finally {
    await fixture.close();
  }
});

test('PUT rejeita ID inválido sem atualizar registros', async () => {
  const fixture = await createFixture();
  try {
    const response = await fixture.requestTaskUpdate('abc', validUpdate);
    assert.equal(response.status, 400);
    const count = await get(fixture.db, 'SELECT COUNT(*) AS total FROM tasks');
    assert.equal(count.total, 2);
  } finally {
    await fixture.close();
  }
});
