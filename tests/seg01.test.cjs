'use strict';
// Testes locais sem dependências externas. Exercitam as rotas reais via mocks isolados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
function setup() {
  const routes = new Map();
  const dbOperations = [];
  const accounts = [{ id: 11, user_id: 1 }, { id: 22, user_id: 2 }];
  const db = {
    get(sql, params, cb) {
      dbOperations.push({ method: 'get', sql, params });
      if (sql.startsWith('SELECT id FROM disciplines')) {
        const found = accounts.find(a => a.id === params[0] && a.user_id === params[1]);
        cb(null, found || undefined);
      } else cb(null, null);
    },
    run(sql, params, cb) {
      dbOperations.push({ method: 'run', sql, params });
      cb.call({ lastID: 99 }, null);
    },
    all(sql, params, cb) {
      dbOperations.push({ method: 'all', sql, params });
      cb(null, []);
    }
  };
  const app = {
    use() {},
    get(route, ...functions) { routes.set(`GET ${route}`, functions); },
    post(route, ...functions) { routes.set(`POST ${route}`, functions); },
    patch(route, ...functions) { routes.set(`PATCH ${route}`, functions); },
    put(route, ...functions) { routes.set(`PUT ${route}`, functions); },
    delete(route, ...functions) { routes.set(`DELETE ${route}`, functions); },
    listen() {}
  };
  function express() { return app; }
  express.json = () => () => {};
  express.static = () => () => {};
  const customRequire = (name) => name === 'express' ? express : name === './database' ? db : require(name);
  vm.runInNewContext(source, { require: customRequire, __dirname: path.join(root, 'backend'), console, process: { env: { PORT: '3000' } } }, { filename: 'server.js' });
  function request(method, route, body, userId = 1) {
    const handlers = routes.get(`${method} ${route}`);
    assert.ok(handlers, `Rota ausente: ${method} ${route}`);
    const handler = handlers[handlers.length - 1];
    let result = null;
    const res = {
      statusCode: 200,
      status(n) { this.statusCode = n; return this; },
      json(payload) { result = { status: this.statusCode, body: payload }; return this; }
    };
    handler({ body, userId, params: {}, headers: {} }, res);
    return result;
  }
  return { request, dbOperations, routes };
}
const body = { title: 'Atividade acadêmica de teste', description: '', due_date: null, priority: 'Média' };
test('disciplina de outro usuário é rejeitada, sem INSERT', () => {
  const c = setup();
  const res = c.request('POST', '/api/tasks', { ...body, discipline_id: 22 });
  assert.equal(res.status, 404);
  assert.equal(c.dbOperations.filter(x=>x.method==='run').length, 0);
});
test('disciplina própria é aceita e vinculada', () => {
  const c = setup();
  const res = c.request('POST', '/api/tasks', { ...body, discipline_id: '11' });
  assert.equal(res.status, 201);
  const insertion = c.dbOperations.find(x => x.method === 'run');
  assert.equal(insertion.params[0], 1);
  assert.equal(insertion.params[1], 11);
});
test('tarefa sem disciplina mantém comportamento da V0', () => {
  const c = setup();
  const res = c.request('POST', '/api/tasks', { ...body });
  assert.equal(res.status, 201);
  assert.equal(c.dbOperations.find(x => x.method === 'run').params[1], null);
});
test('identificador de disciplina inválido retorna 400', () => {
  for (const bad of [-1, 0, 'abc', '1.5', {}, true]) {
    const c = setup();
    const res = c.request('POST', '/api/tasks', { ...body, discipline_id: bad });
    assert.equal(res.status, 400, `valor: ${JSON.stringify(bad)}`);
    assert.equal(c.dbOperations.filter(x => x.method === 'run').length, 0);
  }
});
test('disciplina inexistente não permite criar tarefa', () => {
  const c = setup();
  const res = c.request('POST', '/api/tasks', { ...body, discipline_id: 991 });
  assert.equal(res.status, 404);
});
test('listagem de tarefas restringe JOIN ao proprietário', () => {
  const c = setup();
  const res = c.request('GET', '/api/tasks', undefined);
  assert.equal(res.status, 200);
  const q = c.dbOperations.find(x => x.method === 'all');
  assert.ok(q.sql.includes('d.id = t.discipline_id AND d.user_id = t.user_id'));
  assert.ok(q.sql.includes('WHERE t.user_id = ?'));
});
test('rotas originais de cadastro, login e dashboard continuam declaradas', () => {
  const c = setup();
  for (const key of ['POST /api/register', 'POST /api/login', 'POST /api/logout', 'GET /api/dashboard']) {
    assert.ok(c.routes.has(key));
  }
});
