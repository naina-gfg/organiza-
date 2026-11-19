/* Organiza+ — Dashboard analítico FUNC-04. */
(() => {
  'use strict';
  const api = window.OrganizaAPI;
  const taskUtils = window.OrganizaTaskUtils;
  if (!api || !api.readSession()) {
    window.location.replace('index.html');
    return;
  }

  const session = api.readSession();
  const welcome = document.getElementById('welcome');
  if (welcome && session.user && session.user.name) {
    welcome.textContent = `Olá, ${session.user.name}!`;
  }

  function setText(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value);
    return element;
  }

  function setAnalyticsMessage(text, state = 'success') {
    const message = document.getElementById('analyticsMessage');
    if (!message) return;
    message.textContent = text;
    message.setAttribute('role', state === 'error' ? 'alert' : 'status');
    message.setAttribute('data-state', state);
  }

  function renderDisciplineChart(groups) {
    const chart = document.getElementById('disciplineChart');
    const empty = document.getElementById('disciplineEmpty');
    if (!chart) return;
    chart.replaceChildren();
    if (empty) empty.hidden = groups.length > 0;

    for (const group of groups) {
      const row = document.createElement('div');
      row.className = 'dashboard-chart-row';
      row.setAttribute('role', 'listitem');

      const heading = document.createElement('div');
      heading.className = 'dashboard-chart-heading';
      const name = document.createElement('span');
      name.className = 'dashboard-chart-name';
      name.textContent = group.disciplineName;
      const total = document.createElement('span');
      total.className = 'dashboard-chart-total';
      total.textContent = `${group.total} tarefa(s) · ${group.percent}% do total`;
      heading.append(name, total);

      const track = document.createElement('div');
      track.className = 'dashboard-chart-track';
      track.setAttribute('role', 'img');
      track.setAttribute(
        'aria-label',
        `${group.disciplineName}: ${group.pending} pendentes e ${group.completed} concluídas, ${group.total} no total.`
      );
      const fill = document.createElement('div');
      fill.className = 'dashboard-chart-fill';
      fill.style.width = `${group.percent}%`;
      fill.setAttribute('aria-hidden', 'true');
      const pendingSegment = document.createElement('span');
      pendingSegment.className = 'status-segment status-pending';
      pendingSegment.style.width = `${group.pendingPercent}%`;
      const completedSegment = document.createElement('span');
      completedSegment.className = 'status-segment status-completed';
      completedSegment.style.width = `${group.completedPercent}%`;
      fill.append(pendingSegment, completedSegment);
      track.appendChild(fill);

      const details = document.createElement('p');
      details.className = 'dashboard-chart-details';
      details.textContent = `${group.pending} pendentes · ${group.completed} concluídas`;
      row.append(heading, track, details);
      chart.appendChild(row);
    }
  }

  function renderStatusSummary(summary) {
    const container = document.getElementById('statusSummary');
    if (!container) return;
    container.replaceChildren();
    for (const item of summary) {
      const row = document.createElement('div');
      row.className = 'dashboard-status-row';
      const label = document.createElement('span');
      label.textContent = item.label;
      const value = document.createElement('strong');
      value.textContent = `${item.count} (${item.percent}%)`;
      row.append(label, value);
      container.appendChild(row);
    }

    const pendingBar = document.getElementById('statusPendingBar');
    const completedBar = document.getElementById('statusCompletedBar');
    const pending = summary.find(item => item.status === 'Pendente');
    const completed = summary.find(item => item.status === 'Concluída');
    if (pendingBar) pendingBar.style.width = `${pending?.percent || 0}%`;
    if (completedBar) completedBar.style.width = `${completed?.percent || 0}%`;
  }

  function renderUpcoming(tasks) {
    const list = document.getElementById('upcomingTasks');
    const empty = document.getElementById('upcomingEmpty');
    if (!list) return;
    list.replaceChildren();
    if (empty) empty.hidden = tasks.length > 0;

    for (const task of tasks) {
      const item = document.createElement('li');
      item.className = 'dashboard-upcoming-item';
      const title = document.createElement('strong');
      title.className = 'dashboard-upcoming-title';
      title.textContent = task.title;
      const metadata = document.createElement('p');
      metadata.className = 'dashboard-upcoming-meta';
      const discipline = task.discipline_id == null || task.discipline_id === ''
        ? 'Sem disciplina'
        : (task.discipline_name || 'Disciplina indisponível');
      metadata.textContent = `${taskUtils.formatCalendarDate(task.due_date)} · ${discipline} · Prioridade ${task.priority || 'Média'}`;
      item.append(title, metadata);
      list.appendChild(item);
    }
  }

  function renderAnalytics(tasks) {
    if (!taskUtils || typeof taskUtils.deriveDashboardAnalytics !== 'function') {
      setAnalyticsMessage('Análises indisponíveis nesta versão da interface.', 'error');
      return;
    }

    const today = taskUtils.todayKey(new Date());
    const analytics = taskUtils.deriveDashboardAnalytics(tasks, today);
    setText('overdue', analytics.overdue);
    setText('dueToday', analytics.dueToday);
    setText('dueSoon', analytics.dueSoon);
    renderDisciplineChart(analytics.disciplines);
    renderStatusSummary(analytics.statusSummary);
    renderUpcoming(analytics.upcoming);
    const isEmpty = analytics.total === 0;
    setAnalyticsMessage(
      isEmpty ? 'Nenhuma tarefa cadastrada para análise.' : 'Análises atualizadas.',
      isEmpty ? 'empty' : 'success'
    );
  }

  async function loadDashboard() {
    const message = document.getElementById('dashboardMessage');
    try {
      const data = await api.request('/api/dashboard', { protectedRoute: true });
      for (const key of ['total', 'pending', 'completed']) {
        const target = document.getElementById(key);
        if (target) target.textContent = String(data[key] ?? 0);
      }
      const pct = Number(data.productivity) || 0;
      const boundedPct = Math.max(0, Math.min(100, pct));
      const productivity = document.getElementById('productivity');
      const progressBar = document.getElementById('progressBar');
      if (productivity) productivity.textContent = `${pct}%`;
      if (progressBar) {
        progressBar.style.width = `${boundedPct}%`;
        progressBar.setAttribute('aria-valuenow', String(boundedPct));
      }

      if (!Array.isArray(data.tasks)) {
        setAnalyticsMessage('Análises indisponíveis nesta resposta da API.', 'error');
        api.showMessage(message, 'Indicadores principais carregados.');
        return;
      }

      renderAnalytics(data.tasks);
      api.showMessage(message, 'Indicadores e análises carregados.');
    } catch {
      setAnalyticsMessage('Não foi possível carregar as análises.', 'error');
      api.showMessage(message, 'Não foi possível carregar o dashboard. Verifique sua conexão e tente novamente.', true);
      if (!api.readSession()) window.location.replace('index.html');
    }
  }

  loadDashboard();
})();
