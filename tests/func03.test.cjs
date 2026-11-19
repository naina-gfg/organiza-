'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const taskUtils = require('../frontend/js/task-utils.js');

const TODAY = '2026-06-15';
const sampleTasks = [
  { id: 1, title: 'Atrasada', status: 'Pendente', priority: 'Alta', discipline_id: 10, due_date: '2026-06-14' },
  { id: 2, title: 'Hoje', status: 'Pendente', priority: 'Média', discipline_id: 10, due_date: '2026-06-15' },
  { id: 3, title: 'Em sete dias', status: 'Pendente', priority: 'Baixa', discipline_id: 20, due_date: '2026-06-22' },
  { id: 4, title: 'Depois da janela', status: 'Pendente', priority: 'Alta', discipline_id: 20, due_date: '2026-06-23' },
  { id: 5, title: 'Concluída atrasada', status: 'Concluída', priority: 'Alta', discipline_id: 10, due_date: '2026-06-10' },
  { id: 6, title: 'Sem prazo', status: 'Pendente', priority: 'Baixa', discipline_id: null, due_date: null }
];

function ids(tasks) {
  return tasks.map(task => task.id);
}

test('filtra status, prioridade, disciplina e filtros combinados', () => {
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { status: 'Pendente' }, TODAY)), [1, 2, 3, 4, 6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { priority: 'Alta' }, TODAY)), [1, 4, 5]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { disciplineId: '10' }, TODAY)), [1, 2, 5]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { disciplineId: 'none' }, TODAY)), [6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, {
    status: 'Pendente', priority: 'Alta', disciplineId: '10', dueDate: 'overdue'
  }, TODAY)), [1]);
});

test('classifica vencimentos por dia de calendário e inclui o limite de sete dias', () => {
  assert.equal(taskUtils.classifyDueDate(sampleTasks[0], TODAY), 'overdue');
  assert.equal(taskUtils.classifyDueDate(sampleTasks[1], TODAY), 'today');
  assert.equal(taskUtils.classifyDueDate(sampleTasks[2], TODAY), 'soon');
  assert.equal(taskUtils.classifyDueDate(sampleTasks[3], TODAY), 'upcoming');
  assert.equal(taskUtils.classifyDueDate(sampleTasks[4], TODAY), 'completed');
  assert.equal(taskUtils.classifyDueDate(sampleTasks[5], TODAY), 'no_due');
  const invalidDate = { id: 8, status: 'Pendente', due_date: '2026-02-30' };
  assert.equal(taskUtils.classifyDueDate(invalidDate, TODAY), 'invalid');
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(
    [sampleTasks[5], invalidDate], { dueDate: 'no_due' }, TODAY
  )), [6]);
  const completedWithoutDue = { id: 7, status: 'Concluída', due_date: null };
  assert.equal(taskUtils.classifyDueDate(completedWithoutDue, TODAY), 'completed');
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(
    [...sampleTasks, completedWithoutDue], { dueDate: 'no_due' }, TODAY
  )), [6, 7]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { dueDate: 'overdue' }, TODAY)), [1]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { dueDate: 'today' }, TODAY)), [2]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { dueDate: 'next7' }, TODAY)), [3]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { dueDate: 'no_due' }, TODAY)), [6]);
  assert.equal(taskUtils.dateKey('2026-06-15T00:00:00-07:00'), TODAY);
  assert.equal(taskUtils.todayKey(new Date(2026, 5, 15, 23, 50)), TODAY);
});

test('ordena por prazo e prioridade sem mutar os dados e mantém sem prazo no fim', () => {
  const before = sampleTasks.map(task => ({ ...task }));
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { sortBy: 'current' }, TODAY)), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { sortBy: 'due_asc' }, TODAY)), [5, 1, 2, 3, 4, 6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { sortBy: 'due_desc' }, TODAY)), [4, 3, 2, 1, 5, 6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { sortBy: 'priority_desc' }, TODAY)), [1, 4, 5, 2, 3, 6]);
  assert.deepEqual(ids(taskUtils.filterAndSortTasks(sampleTasks, { sortBy: 'priority_asc' }, TODAY)), [3, 6, 2, 1, 4, 5]);
  assert.deepEqual(sampleTasks, before);
});

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
    return [this._textContent, ...this.children.map(child => child.textContent)].filter(Boolean).join(' ');
  }
  set textContent(value) { this._textContent = String(value); this.children = []; }
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

function createUiFixture(initialTasks = sampleTasks.slice(0, 2)) {
  const fields = Object.fromEntries(Object.entries({
    title: '', description: '', discipline_id: '', due_date: '', priority: 'Média'
  }).map(([name, value]) => {
    const field = new FakeElement(name === 'description' ? 'textarea' : 'input');
    field.name = name;
    field.value = value;
    return [name, field];
  }));
  const form = new FakeElement('form');
  const submit = new FakeElement('button');
  const cancelEdit = new FakeElement('button');
  const formTitle = new FakeElement('h2');
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
  const elements = {
    taskForm: form, taskList: list, taskSummary, message,
    discipline_id: fields.discipline_id, cancelEdit, taskFormTitle: formTitle,
    clearTaskFilters: new FakeElement('button'), ...filters
  };
  form.elements = { namedItem: name => fields[name] };
  form.querySelector = selector => selector === 'button[type="submit"]' ? submit : null;
  form.reset = () => {
    fields.title.value = '';
    fields.description.value = '';
    fields.discipline_id.value = '';
    fields.due_date.value = '';
    fields.priority.value = 'Média';
  };
  submit.textContent = 'Cadastrar tarefa';
  cancelEdit.hidden = true;
  formTitle.textContent = 'Nova tarefa';

  const state = initialTasks.map(task => ({ ...task }));
  const requests = [];
  const writes = [];
  const api = {
    readSession: () => ({ token: 'isolated-test-token' }),
    async request(endpoint, options = {}) {
      requests.push({ endpoint, ...options });
      if (endpoint === '/api/disciplines') return [{ id: 10, name: 'Disciplina A' }, { id: 20, name: 'Disciplina B' }];
      if (endpoint === '/api/tasks' && (!options.method || options.method === 'GET')) return state.map(task => ({ ...task }));
      writes.push({ endpoint, ...options });
      if (endpoint === '/api/tasks' && options.method === 'POST') {
        const id = Math.max(0, ...state.map(task => task.id)) + 1;
        state.push({ ...options.body, id, status: 'Pendente', discipline_name: 'Disciplina A' });
        return { id };
      }
      const id = Number(endpoint.split('/')[3]);
      const index = state.findIndex(task => task.id === id);
      if (options.method === 'PUT') {
        state[index] = { ...state[index], ...options.body };
        return { id };
      }
      if (options.method === 'PATCH') {
        state[index].status = options.body.status;
        return { message: 'Status atualizado.' };
      }
      if (options.method === 'DELETE') {
        state.splice(index, 1);
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
  class FakeOption { constructor(text, value) { this.textContent = String(text); this.value = String(value); } }
  const window = { OrganizaAPI: api, OrganizaTaskUtils: taskUtils, confirm: () => true, location: { replace() {} } };
  const fixedToday = new Date('2026-06-15T12:00:00');
  class FixedDate extends Date {
    constructor(...args) { super(...(args.length ? args : [fixedToday])); }
  }
  const source = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'js', 'tarefas.js'), 'utf8');
  vm.runInNewContext(source, {
    window, document, Date: FixedDate,
    FormData: class { constructor() {} get(name) { return fields[name].value; } },
    Option: FakeOption, encodeURIComponent
  }, { filename: 'frontend/js/tarefas.js' });
  return {
    form, fields, list, message, taskSummary, filters, elements, state, requests, writes,
    async ready() {
      for (let attempt = 0; attempt < 20; attempt += 1) {
        await new Promise(resolve => setImmediate(resolve));
        if (list.children.length) return;
      }
      assert.fail('A lista de tarefas não foi renderizada.');
    }
  };
}

function buttonFor(fixture, index, label) {
  const card = fixture.list.children[index];
  const actions = card?.children.find(child => child.className === 'actions');
  const button = actions?.children.find(child => child.textContent === label);
  assert.ok(button, `botão ${label} deve estar disponível`);
  return button;
}

test('interface filtra sem gravar no servidor e Limpar filtros restaura a lista', async () => {
  const fixture = createUiFixture(sampleTasks);
  await fixture.ready();
  const getRequestsBefore = fixture.requests.length;
  const visibleTitles = () => fixture.list.children
    .filter(child => child.className === 'item')
    .map(card => card.children.find(child => child.className === 'item-head').children[0].textContent);

  assert.deepEqual(visibleTitles(), ['Atrasada', 'Hoje', 'Em sete dias', 'Depois da janela', 'Concluída atrasada', 'Sem prazo']);
  const completedBadges = fixture.list.children[4].children
    .find(child => child.className === 'item-head').children
    .find(child => child.className === 'task-badges');
  assert.match(completedBadges.textContent, /Concluída/);
  assert.doesNotMatch(completedBadges.textContent, /Atrasada|Vence hoje|Vence em breve/);
  fixture.filters.taskSort.value = 'due_desc';
  await fixture.filters.taskSort.trigger('change');
  assert.deepEqual(visibleTitles(), ['Depois da janela', 'Em sete dias', 'Hoje', 'Atrasada', 'Concluída atrasada', 'Sem prazo']);
  fixture.filters.taskSort.value = 'current';
  await fixture.filters.taskSort.trigger('change');

  fixture.filters.statusFilter.value = 'Pendente';
  await fixture.filters.statusFilter.trigger('change');
  assert.equal(fixture.list.children.length, 5);
  assert.equal(fixture.taskSummary.textContent, 'Exibindo 5 de 6 tarefas.');
  fixture.filters.dueDateFilter.value = 'overdue';
  await fixture.filters.dueDateFilter.trigger('change');
  assert.equal(fixture.list.children.length, 1);
  assert.match(fixture.list.children[0].textContent, /Atrasada/);
  assert.equal(fixture.requests.length, getRequestsBefore);
  assert.equal(fixture.writes.length, 0);
  await fixture.elements.clearTaskFilters.trigger('click');
  assert.equal(fixture.filters.statusFilter.value, 'all');
  assert.equal(fixture.filters.dueDateFilter.value, 'all');
  assert.equal(fixture.list.children.length, 6);
  assert.match(fixture.list.children[4].textContent, /Concluída atrasada/);
});

test('Limpar filtros restaura Ordem atual após cada ordenação e filtros combinados sem gravar', async () => {
  const fixture = createUiFixture(sampleTasks);
  await fixture.ready();
  const getRequestsBefore = fixture.requests.length;
  const visibleTitles = () => fixture.list.children
    .filter(child => child.className === 'item')
    .map(card => card.children.find(child => child.className === 'item-head').children[0].textContent);
  const originalTitles = sampleTasks.map(task => task.title);
  const assertReset = async () => {
    await fixture.elements.clearTaskFilters.trigger('click');
    assert.deepEqual({
      status: fixture.filters.statusFilter.value,
      priority: fixture.filters.priorityFilter.value,
      discipline: fixture.filters.disciplineFilter.value,
      dueDate: fixture.filters.dueDateFilter.value,
      sort: fixture.filters.taskSort.value
    }, {
      status: 'all', priority: 'all', discipline: 'all', dueDate: 'all', sort: 'current'
    });
    assert.deepEqual(visibleTitles(), originalTitles);
    assert.equal(fixture.requests.length, getRequestsBefore);
    assert.equal(fixture.writes.length, 0);
  };

  for (const sortBy of ['priority_desc', 'priority_asc', 'due_asc', 'due_desc']) {
    fixture.filters.taskSort.value = sortBy;
    await fixture.filters.taskSort.trigger('change');
    assert.deepEqual(visibleTitles(), taskUtils.filterAndSortTasks(
      sampleTasks, { sortBy }, TODAY
    ).map(task => task.title));
    await assertReset();
  }

  for (const [filter, value] of [
    [fixture.filters.statusFilter, 'Pendente'],
    [fixture.filters.priorityFilter, 'Alta'],
    [fixture.filters.disciplineFilter, '10'],
    [fixture.filters.dueDateFilter, 'overdue'],
    [fixture.filters.taskSort, 'priority_asc']
  ]) {
    filter.value = value;
    await filter.trigger('change');
  }
  assert.deepEqual(visibleTitles(), ['Atrasada']);
  await assertReset();
});

test('mensagem vazia distingue filtro sem resultados de lista sem tarefas', async () => {
  const fixture = createUiFixture(sampleTasks);
  await fixture.ready();
  fixture.filters.disciplineFilter.value = '999';
  await fixture.filters.disciplineFilter.trigger('change');
  assert.match(fixture.list.textContent, /Nenhuma tarefa corresponde aos filtros/);

  const empty = createUiFixture([]);
  await empty.ready();
  assert.match(empty.list.textContent, /Nenhuma tarefa cadastrada/);
});

test('HTML inclui controles acessíveis e carrega as regras antes da tela', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'frontend', 'tarefas.html'), 'utf8');
  for (const id of ['statusFilter', 'priorityFilter', 'disciplineFilter', 'dueDateFilter', 'taskSort', 'clearTaskFilters']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.ok(html.indexOf('js/task-utils.js') < html.indexOf('js/tarefas.js'));
});

test('atualizações preservam filtros ativos em cadastro, edição, conclusão, reabertura e exclusão', async () => {
  const fixture = createUiFixture(sampleTasks.slice(0, 2));
  await fixture.ready();
  fixture.filters.statusFilter.value = 'Pendente';
  await fixture.filters.statusFilter.trigger('change');
  const taskId = fixture.state[0].id;

  await buttonFor(fixture, 0, 'Editar').trigger('click');
  fixture.fields.title.value = 'Atrasada revisada';
  await fixture.form.trigger('submit', { preventDefault() {} });
  assert.equal(fixture.filters.statusFilter.value, 'Pendente');
  assert.equal(fixture.list.children.length, 2);
  assert.equal(fixture.state.find(task => task.id === taskId).status, 'Pendente');

  fixture.fields.title.value = 'Nova tarefa';
  await fixture.form.trigger('submit', { preventDefault() {} });
  assert.equal(fixture.filters.statusFilter.value, 'Pendente');
  assert.equal(fixture.list.children.length, 3);

  await buttonFor(fixture, 0, 'Concluir').trigger('click');
  assert.equal(fixture.filters.statusFilter.value, 'Pendente');
  assert.equal(fixture.list.children.length, 2);
  assert.equal(fixture.state.find(task => task.id === taskId).status, 'Concluída');

  fixture.filters.statusFilter.value = 'Concluída';
  await fixture.filters.statusFilter.trigger('change');
  assert.equal(fixture.list.children.length, 1);
  await buttonFor(fixture, 0, 'Reabrir').trigger('click');
  assert.equal(fixture.filters.statusFilter.value, 'Concluída');
  assert.equal(fixture.list.children.filter(child => child.className === 'item').length, 0);
  assert.match(fixture.list.textContent, /Nenhuma tarefa corresponde aos filtros/);

  fixture.filters.statusFilter.value = 'Pendente';
  await fixture.filters.statusFilter.trigger('change');
  await buttonFor(fixture, 0, 'Excluir').trigger('click');
  assert.equal(fixture.filters.statusFilter.value, 'Pendente');
  assert.equal(fixture.state.some(task => task.id === taskId), false);
  assert.ok(fixture.writes.some(request => request.method === 'POST'));
  assert.ok(fixture.writes.some(request => request.method === 'PUT'));
  assert.ok(fixture.writes.some(request => request.method === 'PATCH'));
  assert.ok(fixture.writes.some(request => request.method === 'DELETE'));
});
