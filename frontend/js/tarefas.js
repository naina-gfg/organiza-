/* Organiza+ - Recuperacao do modulo Tarefas */
(() => {
  'use strict';

  const api = window.OrganizaAPI;

  if (!api || !api.readSession()) {
    window.location.replace('index.html');
    return;
  }

  const form = document.getElementById('taskForm');
  const list = document.getElementById('taskList');
  const summary = document.getElementById('taskSummary');
  const message = document.getElementById('message');
  const disciplineSelect = document.getElementById('discipline_id');
  const statusFilter = document.getElementById('statusFilter');
  const priorityFilter = document.getElementById('priorityFilter');
  const disciplineFilter = document.getElementById('disciplineFilter');
  const dueDateFilter = document.getElementById('dueDateFilter');
  const taskSort = document.getElementById('taskSort');
  const clearTaskFilters = document.getElementById('clearTaskFilters');
  const taskUtils = window.OrganizaTaskUtils;
  const submit = form.querySelector('button[type="submit"]');
  const cancelEdit = document.getElementById('cancelEdit');
  const formTitle = document.getElementById('taskFormTitle');
  let editingTaskId = null;
  let allTasks = [];

  function returnToCreateMode() {
    editingTaskId = null;
    form.reset();
    formTitle.textContent = 'Nova tarefa';
    submit.textContent = 'Cadastrar tarefa';
    cancelEdit.hidden = true;
    cancelEdit.disabled = false;
  }

  function startEditing(task) {
    editingTaskId = task.id;
    form.elements.namedItem('title').value = task.title || '';
    form.elements.namedItem('description').value = task.description || '';
    form.elements.namedItem('discipline_id').value =
      task.discipline_id == null ? '' : String(task.discipline_id);
    form.elements.namedItem('due_date').value =
      task.due_date ? String(task.due_date).slice(0, 10) : '';
    form.elements.namedItem('priority').value = task.priority || 'Média';
    formTitle.textContent = 'Editar tarefa';
    submit.textContent = 'Salvar alterações';
    cancelEdit.hidden = false;
    message.textContent = '';
    form.elements.namedItem('title').focus();
  }

  cancelEdit.addEventListener('click', () => {
    returnToCreateMode();
    api.showMessage(message, 'Edição cancelada. Nenhuma alteração foi salva.');
  });

  function currentFilters() {
    return {
      status: statusFilter.value,
      priority: priorityFilter.value,
      disciplineId: disciplineFilter.value,
      dueDate: dueDateFilter.value,
      sortBy: taskSort.value
    };
  }

  function createBadge(text, className) {
    const badge = document.createElement('span');
    badge.className = `badge ${className}`;
    badge.textContent = text;
    return badge;
  }

  function renderTasks() {
    const today = taskUtils.todayKey(new Date());
    const tasks = taskUtils.filterAndSortTasks(allTasks, currentFilters(), today);
    list.replaceChildren();
    summary.textContent = `Exibindo ${tasks.length} de ${allTasks.length} tarefas.`;

    if (allTasks.length === 0 || tasks.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'muted';
      empty.textContent = allTasks.length === 0
        ? 'Nenhuma tarefa cadastrada.'
        : 'Nenhuma tarefa corresponde aos filtros selecionados.';
      list.appendChild(empty);
      return;
    }

    for (const task of tasks) {
      const item = document.createElement('div');
      item.className = 'item';

      const header = document.createElement('div');
      header.className = 'item-head';

      const title = document.createElement('strong');
      title.textContent = task.title;

      const badges = document.createElement('div');
      badges.className = 'task-badges';
      const completed = task.status === 'Concluída';
      badges.appendChild(createBadge(
        task.status || 'Pendente',
        completed ? 'badge-completed' : 'badge-pending'
      ));

      if (!completed) {
        const dueState = taskUtils.classifyDueDate(task, today);
        const dueIndicator = {
          overdue: ['Atrasada', 'badge-overdue'],
          today: ['Vence hoje', 'badge-due-today'],
          soon: ['Vence em breve', 'badge-due-soon']
        }[dueState];
        if (dueIndicator) badges.appendChild(createBadge(...dueIndicator));
      }

      header.append(title, badges);
      item.appendChild(header);

      const details = document.createElement('p');
      details.className = 'muted';
      details.textContent =
        `Disciplina: ${task.discipline_name || 'Sem disciplina'} | ` +
        `Prazo: ${taskUtils.formatCalendarDate(task.due_date)} | ` +
        `Prioridade: ${task.priority || 'Média'}`;
      item.appendChild(details);

      if (task.description) {
        const description = document.createElement('p');
        description.textContent = task.description;
        item.appendChild(description);
      }

      const actions = document.createElement('div');
      actions.className = 'actions';

      const edit = document.createElement('button');
      edit.type = 'button';
      edit.className = 'btn-secondary';
      edit.textContent = 'Editar';

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'btn-success';
      toggle.textContent = completed ? 'Reabrir' : 'Concluir';

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.className = 'btn-danger';
      remove.textContent = 'Excluir';

      edit.addEventListener('click', () => {
        if (!submit.disabled) startEditing(task);
      });

      toggle.addEventListener('click', async () => {
        toggle.disabled = true;
        remove.disabled = true;

        try {
          await api.request(
            `/api/tasks/${encodeURIComponent(task.id)}/status`,
            {
              method: 'PATCH',
              body: { status: completed ? 'Pendente' : 'Concluída' },
              protectedRoute: true
            }
          );

          await loadTasks();
          api.showMessage(message, 'Status da tarefa atualizado.');
        } catch (error) {
          api.showMessage(message, error.message, true);
          toggle.disabled = false;
          remove.disabled = false;
        }
      });

      remove.addEventListener('click', async () => {
        if (!window.confirm(`Excluir a tarefa "${task.title}"?`)) return;

        toggle.disabled = true;
        remove.disabled = true;

        try {
          await api.request(
            `/api/tasks/${encodeURIComponent(task.id)}`,
            { method: 'DELETE', protectedRoute: true }
          );

          await loadTasks();
          api.showMessage(message, 'Tarefa excluída.');
        } catch (error) {
          api.showMessage(message, error.message, true);
          toggle.disabled = false;
          remove.disabled = false;
        }
      });

      actions.append(edit, toggle, remove);
      item.appendChild(actions);
      list.appendChild(item);
    }
  }

  for (const control of [statusFilter, priorityFilter, disciplineFilter, dueDateFilter, taskSort]) {
    control.addEventListener('change', renderTasks);
  }

  clearTaskFilters.addEventListener('click', () => {
    statusFilter.value = 'all';
    priorityFilter.value = 'all';
    disciplineFilter.value = 'all';
    dueDateFilter.value = 'all';
    taskSort.value = 'current';
    renderTasks();
  });

  async function loadDisciplines() {
    const disciplines = await api.request('/api/disciplines', {
      protectedRoute: true
    });

    disciplineSelect.replaceChildren(new Option('Sem disciplina', ''));
    disciplineFilter.replaceChildren(
      new Option('Todas', 'all'),
      new Option('Sem disciplina', 'none')
    );

    for (const discipline of disciplines) {
      disciplineSelect.add(new Option(discipline.name, String(discipline.id)));
      disciplineFilter.add(new Option(discipline.name, String(discipline.id)));
    }
  }

  async function loadTasks() {
    const tasks = await api.request('/api/tasks', { protectedRoute: true });
    allTasks = Array.isArray(tasks) ? tasks : [];
    renderTasks();
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const data = new FormData(form);
    const title = String(data.get('title') || '').trim();

    if (!title) {
      api.showMessage(message, 'Informe o título da tarefa.', true);
      return;
    }

    const disciplineValue = String(data.get('discipline_id') || '');
    const body = {
      title,
      description: String(data.get('description') || '').trim(),
      discipline_id: disciplineValue ? Number(disciplineValue) : null,
      due_date: String(data.get('due_date') || '') || null,
      priority: String(data.get('priority') || 'Média')
    };

    const isEditing = editingTaskId !== null;
    const successMessage = isEditing
      ? 'Tarefa atualizada com sucesso.'
      : 'Tarefa cadastrada com sucesso.';
    const endpoint = isEditing
      ? `/api/tasks/${encodeURIComponent(editingTaskId)}`
      : '/api/tasks';

    submit.disabled = true;
    cancelEdit.disabled = true;

    try {
      await api.request(endpoint, {
        method: isEditing ? 'PUT' : 'POST',
        body,
        protectedRoute: true
      });

      returnToCreateMode();

      try {
        await loadTasks();
      } catch (error) {
        api.showMessage(
          message,
          `${successMessage} A lista não pôde ser atualizada: ${error.message}`,
          true
        );
        return;
      }

      api.showMessage(message, successMessage);
    } catch (error) {
      api.showMessage(message, error.message, true);
    } finally {
      submit.disabled = false;
      cancelEdit.disabled = false;
    }
  });

  Promise.all([loadDisciplines(), loadTasks()]).catch((error) => {
    api.showMessage(message, error.message, true);

    if (!api.readSession()) {
      window.location.replace('index.html');
    }
  });
})();
