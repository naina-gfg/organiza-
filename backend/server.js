const express = require('express');
const path = require('path');
const crypto = require('crypto');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const sessions = new Map();

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.substring(7) : null;
  const userId = token ? sessions.get(token) : null;

  if (!userId) {
    return res.status(401).json({ error: 'Usuário não autenticado.' });
  }

  req.userId = userId;
  next();
}

app.post('/api/register', (req, res) => {
  const { name, email, password } = req.body;
  if (!name || !email || !password) {
    return res.status(400).json({ error: 'Preencha nome, e-mail e senha.' });
  }

  const passwordHash = hashPassword(password);
  db.run(
    'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
    [name.trim(), email.trim().toLowerCase(), passwordHash],
    function (err) {
      if (err) {
        if (err.message.includes('UNIQUE')) {
          return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
        }
        return res.status(500).json({ error: 'Erro ao cadastrar usuário.' });
      }
      res.status(201).json({ message: 'Cadastro realizado com sucesso.' });
    }
  );
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body;
  if (!email || !password) {
    return res.status(400).json({ error: 'Informe e-mail e senha.' });
  }

  db.get(
    'SELECT id, name, email, password_hash FROM users WHERE email = ?',
    [email.trim().toLowerCase()],
    (err, user) => {
      if (err) return res.status(500).json({ error: 'Erro interno.' });
      if (!user || user.password_hash !== hashPassword(password)) {
        return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
      }

      const token = crypto.randomUUID();
      sessions.set(token, user.id);
      res.json({
        token,
        user: { id: user.id, name: user.name, email: user.email }
      });
    }
  );
});

app.post('/api/logout', auth, (req, res) => {
  const token = (req.headers.authorization || '').substring(7);
  sessions.delete(token);
  res.json({ message: 'Sessão encerrada.' });
});

app.get('/api/dashboard', auth, (req, res) => {
  db.all(
    `WITH task_metrics AS (
       SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN status = 'Concluída' THEN 1 ELSE 0 END) AS completed,
         SUM(CASE WHEN status = 'Pendente' THEN 1 ELSE 0 END) AS pending
       FROM tasks WHERE user_id = ?
     )
     SELECT
       task_metrics.total,
       task_metrics.completed,
       task_metrics.pending,
       t.id,
       t.title,
       t.status,
       t.priority,
       t.due_date,
       t.discipline_id,
       d.name AS discipline_name
     FROM task_metrics
     LEFT JOIN tasks t ON t.user_id = ?
     LEFT JOIN disciplines d ON d.id = t.discipline_id AND d.user_id = t.user_id
     ORDER BY
       CASE t.status WHEN 'Pendente' THEN 0 ELSE 1 END,
       CASE t.priority WHEN 'Alta' THEN 0 WHEN 'Média' THEN 1 ELSE 2 END,
       t.due_date`,
    [req.userId, req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao carregar dashboard.' });
      const row = rows[0];
      const total = row.total || 0;
      const completed = row.completed || 0;
      const pending = row.pending || 0;
      const productivity = total ? Math.round((completed / total) * 100) : 0;
      const tasks = rows
        .filter(item => item.id !== null)
        .map(item => ({
          id: item.id,
          title: item.title,
          status: item.status,
          priority: item.priority,
          due_date: item.due_date,
          discipline_id: item.discipline_id,
          discipline_name: item.discipline_name
        }));
      res.json({ total, completed, pending, productivity, tasks });
    }
  );
});

app.get('/api/disciplines', auth, (req, res) => {
  db.all(
    'SELECT id, name, created_at FROM disciplines WHERE user_id = ? ORDER BY name',
    [req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao listar disciplinas.' });
      res.json(rows);
    }
  );
});

app.post('/api/disciplines', auth, (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'Informe o nome da disciplina.' });
  }

  db.run(
    'INSERT INTO disciplines (user_id, name) VALUES (?, ?)',
    [req.userId, name.trim()],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao cadastrar disciplina.' });
      res.status(201).json({ id: this.lastID, name: name.trim() });
    }
  );
});

app.delete('/api/disciplines/:id', auth, (req, res) => {
  db.run(
    'DELETE FROM disciplines WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao excluir disciplina.' });
      res.json({ message: 'Disciplina excluída.' });
    }
  );
});

app.get('/api/tasks', auth, (req, res) => {
  db.all(
    `SELECT t.*, d.name AS discipline_name
     FROM tasks t
     LEFT JOIN disciplines d ON d.id = t.discipline_id AND d.user_id = t.user_id
     WHERE t.user_id = ?
     ORDER BY
       CASE t.status WHEN 'Pendente' THEN 0 ELSE 1 END,
       CASE t.priority WHEN 'Alta' THEN 0 WHEN 'Média' THEN 1 ELSE 2 END,
       t.due_date`,
    [req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao listar tarefas.' });
      res.json(rows);
    }
  );
});

app.post('/api/tasks', auth, (req, res) => {
  const { title, description, discipline_id, due_date, priority } = req.body;
  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Informe o título da tarefa.' });
  }

  // Preserva a criação de tarefas sem disciplina, existente na V0.
  function insertTask(verifiedDisciplineId) {
    db.run(
      `INSERT INTO tasks
        (user_id, discipline_id, title, description, due_date, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Pendente')`,
      [
        req.userId,
        verifiedDisciplineId,
        title.trim(),
        typeof description === 'string' ? description.trim() : '',
        due_date || null,
        priority || 'Média'
      ],
      function (err) {
        if (err) return res.status(500).json({ error: 'Erro ao cadastrar tarefa.' });
        res.status(201).json({ id: this.lastID, message: 'Tarefa cadastrada.' });
      }
    );
  }

  if (discipline_id === null || discipline_id === undefined || discipline_id === '') {
    return insertTask(null);
  }
  if (typeof discipline_id !== 'number' && typeof discipline_id !== 'string') {
    return res.status(400).json({ error: 'Disciplina inválida.' });
  }
  const selectedDisciplineId = Number(discipline_id);
  if (!Number.isSafeInteger(selectedDisciplineId) || selectedDisciplineId <= 0) {
    return res.status(400).json({ error: 'Disciplina inválida.' });
  }

  // Validação de propriedade antes de associar tarefa e disciplina.
  db.get(
    'SELECT id FROM disciplines WHERE id = ? AND user_id = ?',
    [selectedDisciplineId, req.userId],
    (err, discipline) => {
      if (err) return res.status(500).json({ error: 'Erro ao validar disciplina.' });
      if (!discipline) {
        return res.status(404).json({ error: 'Disciplina não encontrada para este usuário.' });
      }
      insertTask(discipline.id);
    }
  );
});

/* FUNC-02 - Edicao completa de tarefas */
app.put('/api/tasks/:id', auth, (req, res) => {
  const taskId = Number(req.params.id);

  if (!Number.isSafeInteger(taskId) || taskId <= 0) {
    return res.status(400).json({ error: 'ID da tarefa invalido.' });
  }

  const { title, description, discipline_id, due_date, priority } = req.body || {};

  if (typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'Informe o titulo da tarefa.' });
  }

  if (description != null && typeof description !== 'string') {
    return res.status(400).json({ error: 'Descricao invalida.' });
  }

  if (!['Baixa', 'Média', 'Alta'].includes(priority)) {
    return res.status(400).json({ error: 'Prioridade invalida.' });
  }

  const prazo = due_date === null || due_date === '' ? null : due_date;

  if (prazo !== null) {
    if (typeof prazo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(prazo)) {
      return res.status(400).json({ error: 'Prazo invalido.' });
    }

    const date = new Date(`${prazo}T00:00:00Z`);

    if (Number.isNaN(date.getTime()) ||
        date.toISOString().slice(0, 10) !== prazo) {
      return res.status(400).json({ error: 'Data inexistente.' });
    }
  }

  let disciplineId = null;

  if (discipline_id !== null &&
      discipline_id !== undefined &&
      discipline_id !== '') {
    if (typeof discipline_id !== 'number' &&
        typeof discipline_id !== 'string') {
      return res.status(400).json({ error: 'Disciplina invalida.' });
    }

    disciplineId = Number(discipline_id);

    if (!Number.isSafeInteger(disciplineId) || disciplineId <= 0) {
      return res.status(400).json({ error: 'Disciplina invalida.' });
    }
  }

  db.get(
    'SELECT id FROM tasks WHERE id = ? AND user_id = ?',
    [taskId, req.userId],
    (err, task) => {
      if (err) return res.status(500).json({ error: 'Erro ao consultar tarefa.' });
      if (!task) return res.status(404).json({ error: 'Tarefa nao encontrada.' });

      function updateTask(verifiedDisciplineId) {
        db.run(
          `UPDATE tasks
           SET title = ?, description = ?, discipline_id = ?,
               due_date = ?, priority = ?
           WHERE id = ? AND user_id = ?`,
          [
            title.trim(),
            (description || '').trim(),
            verifiedDisciplineId,
            prazo,
            priority,
            taskId,
            req.userId
          ],
          function (updateError) {
            if (updateError) {
              return res.status(500).json({ error: 'Erro ao atualizar tarefa.' });
            }

            if (this.changes === 0) {
              return res.status(404).json({ error: 'Tarefa nao encontrada.' });
            }

            res.json({ message: 'Tarefa atualizada com sucesso.', id: taskId });
          }
        );
      }

      if (disciplineId === null) {
        return updateTask(null);
      }

      db.get(
        'SELECT id FROM disciplines WHERE id = ? AND user_id = ?',
        [disciplineId, req.userId],
        (disciplineError, discipline) => {
          if (disciplineError) {
            return res.status(500).json({ error: 'Erro ao validar disciplina.' });
          }

          if (!discipline) {
            return res.status(404).json({
              error: 'Disciplina nao encontrada para este usuario.'
            });
          }

          updateTask(discipline.id);
        }
      );
    }
  );
});

app.patch('/api/tasks/:id/status', auth, (req, res) => {
  const { status } = req.body;
  if (!['Pendente', 'Concluída'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  db.run(
    'UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?',
    [status, req.params.id, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar tarefa.' });
      res.json({ message: 'Status atualizado.' });
    }
  );
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  db.run(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?',
    [req.params.id, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao excluir tarefa.' });
      res.json({ message: 'Tarefa excluída.' });
    }
  );
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`Servidor iniciado em http://localhost:${PORT}`);
});
