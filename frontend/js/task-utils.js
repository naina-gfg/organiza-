/* Regras puras de calendário, filtragem e ordenação de tarefas. */
((root, factory) => {
  const taskUtils = factory();

  if (typeof module === 'object' && module.exports) {
    module.exports = taskUtils;
  }
  if (root) {
    root.OrganizaTaskUtils = taskUtils;
  }
})(typeof globalThis !== 'undefined' ? globalThis : this, () => {
  'use strict';

  const PRIORITY_RANK = Object.freeze({
    Baixa: 1,
    'Média': 2,
    Alta: 3
  });
  const DAY_MS = 24 * 60 * 60 * 1000;

  function localDateKey(date) {
    if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
    const year = String(date.getFullYear()).padStart(4, '0');
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  function dateKey(value) {
    if (value instanceof Date) return localDateKey(value);
    if (typeof value !== 'string') return null;

    const match = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/.exec(value.trim());
    if (!match) return null;

    const [, yearText, monthText, dayText] = match;
    const year = Number(yearText);
    const month = Number(monthText);
    const day = Number(dayText);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);

    if (
      date.getUTCFullYear() !== year ||
      date.getUTCMonth() !== month - 1 ||
      date.getUTCDate() !== day
    ) return null;

    return `${yearText}-${monthText}-${dayText}`;
  }

  function dayNumber(value) {
    const key = dateKey(value);
    if (!key) return null;
    const [year, month, day] = key.split('-').map(Number);
    const date = new Date(0);
    date.setUTCHours(0, 0, 0, 0);
    date.setUTCFullYear(year, month - 1, day);
    return Math.floor(date.getTime() / DAY_MS);
  }

  function todayKey(now = new Date()) {
    return now instanceof Date ? localDateKey(now) : dateKey(now);
  }

  function classifyDueDate(task, today = todayKey()) {
    if (task?.status === 'Concluída') return 'completed';

    const dueDate = dateKey(task?.due_date);
    if (!dueDate) {
      const rawDueDate = task?.due_date;
      return rawDueDate == null || (typeof rawDueDate === 'string' && !rawDueDate.trim())
        ? 'no_due'
        : 'invalid';
    }

    const dueDay = dayNumber(dueDate);
    const todayDay = dayNumber(today);
    if (dueDay === null || todayDay === null) return 'invalid';
    if (dueDay < todayDay) return 'overdue';
    if (dueDay === todayDay) return 'today';
    if (dueDay <= todayDay + 7) return 'soon';
    return 'upcoming';
  }

  function formatCalendarDate(value) {
    const key = dateKey(value);
    if (!key) return value == null || value === '' ? 'Sem prazo' : String(value);
    const [year, month, day] = key.split('-');
    return `${day}/${month}/${year}`;
  }

  function dueFilterMatches(task, dueFilter, today) {
    if (!dueFilter || dueFilter === 'all') return true;
    if (dueFilter === 'no_due') {
      const rawDueDate = task?.due_date;
      return rawDueDate == null || (typeof rawDueDate === 'string' && !rawDueDate.trim());
    }

    const classification = classifyDueDate(task, today);
    if (dueFilter === 'overdue') return classification === 'overdue';
    if (dueFilter === 'today') return classification === 'today';
    if (dueFilter === 'next7') return classification === 'soon';
    return true;
  }

  function compareTasks(a, b, sortBy) {
    if (sortBy === 'current') return a.index - b.index;

    if (sortBy === 'priority_desc' || sortBy === 'priority_asc') {
      const rankA = PRIORITY_RANK[a.task?.priority] || 0;
      const rankB = PRIORITY_RANK[b.task?.priority] || 0;
      const difference = sortBy === 'priority_desc'
        ? rankB - rankA
        : rankA - rankB;
      return difference || a.index - b.index;
    }

    const dayA = dayNumber(a.task?.due_date);
    const dayB = dayNumber(b.task?.due_date);
    if (dayA === null && dayB !== null) return 1;
    if (dayB === null && dayA !== null) return -1;
    if (dayA === null && dayB === null) return a.index - b.index;

    const difference = sortBy === 'due_desc' ? dayB - dayA : dayA - dayB;
    return difference || a.index - b.index;
  }

  function filterAndSortTasks(tasks, filters = {}, today = todayKey()) {
    const statusFilter = filters.status || 'all';
    const priorityFilter = filters.priority || 'all';
    const disciplineFilter = filters.disciplineId || 'all';
    const dueFilter = filters.dueDate || 'all';
    const sortBy = filters.sortBy || 'current';

    return (Array.isArray(tasks) ? tasks : [])
      .map((task, index) => ({ task, index }))
      .filter(({ task }) => {
        if (statusFilter !== 'all' && (task.status || 'Pendente') !== statusFilter) return false;
        if (priorityFilter !== 'all' && task.priority !== priorityFilter) return false;
        if (disciplineFilter === 'none' && task.discipline_id != null) return false;
        if (
          disciplineFilter !== 'all' &&
          disciplineFilter !== 'none' &&
          String(task.discipline_id ?? '') !== String(disciplineFilter)
        ) return false;
        return dueFilterMatches(task, dueFilter, today);
      })
      .sort((a, b) => compareTasks(a, b, sortBy))
      .map(({ task }) => task);
  }

  function deriveDashboardAnalytics(tasks, todayValue = todayKey()) {
    const source = Array.isArray(tasks) ? tasks : [];
    const pendingTasks = source.filter(task => task?.status === 'Pendente');
    const completedTasks = source.filter(task => task?.status === 'Concluída');
    const total = source.length;
    const pending = pendingTasks.length;
    const completed = completedTasks.length;
    const percent = (count, denominator) => denominator
      ? Math.round((count / denominator) * 100)
      : 0;

    const groups = new Map();
    for (const task of source) {
      const hasDiscipline = task?.discipline_id !== null &&
        task?.discipline_id !== undefined && String(task.discipline_id).trim() !== '';
      const disciplineId = hasDiscipline ? task.discipline_id : null;
      const key = hasDiscipline ? `discipline:${String(disciplineId)}` : 'discipline:none';
      let group = groups.get(key);
      if (!group) {
        group = {
          disciplineId,
          disciplineName: hasDiscipline
            ? (typeof task.discipline_name === 'string' && task.discipline_name.trim()
              ? task.discipline_name.trim()
              : 'Disciplina indisponível')
            : 'Sem disciplina',
          total: 0,
          pending: 0,
          completed: 0
        };
        groups.set(key, group);
      }
      group.total += 1;
      if (task?.status === 'Pendente') group.pending += 1;
      if (task?.status === 'Concluída') group.completed += 1;
    }

    const disciplines = Array.from(groups.values(), group => ({
      ...group,
      percent: percent(group.total, total),
      pendingPercent: percent(group.pending, group.total),
      completedPercent: percent(group.completed, group.total)
    }));

    const today = dateKey(todayValue);
    const dueCounts = { overdue: 0, dueToday: 0, dueSoon: 0 };
    for (const task of pendingTasks) {
      const dueState = classifyDueDate(task, today);
      if (dueState === 'overdue') dueCounts.overdue += 1;
      if (dueState === 'today') dueCounts.dueToday += 1;
      if (dueState === 'soon') dueCounts.dueSoon += 1;
    }

    const upcoming = pendingTasks
      .map((task, index) => ({ task, index, dueDate: dateKey(task?.due_date) }))
      .filter(entry => entry.dueDate && today && entry.dueDate >= today)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate) || a.index - b.index)
      .slice(0, 5)
      .map(entry => entry.task);

    return {
      total,
      pending,
      completed,
      productivity: total ? Math.round((completed / total) * 100) : 0,
      ...dueCounts,
      disciplines,
      statusSummary: [
        { status: 'Pendente', label: 'Pendentes', count: pending, percent: percent(pending, total) },
        { status: 'Concluída', label: 'Concluídas', count: completed, percent: percent(completed, total) }
      ],
      upcoming
    };
  }

  return Object.freeze({
    dateKey,
    todayKey,
    classifyDueDate,
    formatCalendarDate,
    filterAndSortTasks,
    deriveDashboardAnalytics
  });
});
