const express = require('express');
const path = require('path');
const db = require('./database');
const { createPasswordManager, CryptoBusyError } = require(path.join(__dirname, 'security', 'password'));
const {
  resolveSessionTtlMs,
  createSession,
  validateSession,
  revokeSession
} = require(path.join(__dirname, 'security', 'session'));
const {
  resolveRateLimitConfig,
  resolveTrustProxy,
  getClientIp,
  consumeRateLimit,
  resetRateLimit,
  cleanupExpiredRateLimits
} = require(path.join(__dirname, 'security', 'rate-limit'));
const { applySecurityHeaders } = require(path.join(__dirname, 'security', 'headers'));

const app = express();
const PORT = process.env.PORT || 3000;
const MAX_PG_INT = 2147483647;
const MAX_NAME_LENGTH = 120;
const MAX_EMAIL_LENGTH = 254;
const MAX_TASK_TITLE_LENGTH = 200;
const MAX_TASK_DESCRIPTION_LENGTH = 2000;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const passwordManager = createPasswordManager(process.env);
const sessionTtlMs = resolveSessionTtlMs(process.env);
const rateLimitConfig = resolveRateLimitConfig(process.env);
const trustProxy = resolveTrustProxy(process.env);

if (typeof app.disable === 'function') app.disable('x-powered-by');
if (typeof app.set === 'function') app.set('trust proxy', trustProxy);

app.use(applySecurityHeaders);
app.use(express.json({ limit: '16kb' }));
app.use(express.static(path.join(__dirname, '..', 'frontend')));

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function parsePositiveId(rawId) {
  if (typeof rawId === 'number') {
    return Number.isSafeInteger(rawId) && rawId > 0 && rawId <= MAX_PG_INT ? rawId : null;
  }
  if (typeof rawId !== 'string') return null;
  const trimmed = rawId.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed > 0 && parsed <= MAX_PG_INT ? parsed : null;
}

function isUniqueConstraintError(err) {
  return Boolean(
    err &&
    (err.code === '23505' ||
      (typeof err.message === 'string' && err.message.includes('UNIQUE')))
  );
}

function isForeignKeyError(err) {
  return Boolean(
    err &&
    (err.code === '23503' ||
      err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
      err.code === 'SQLITE_CONSTRAINT_TRIGGER' ||
      (typeof err.message === 'string' &&
        (err.message.includes('FOREIGN KEY constraint failed') ||
          err.message.includes('CROSS_USER_DISCIPLINE'))))
  );
}

function validateTaskPayload(rawBody, { requirePriority = false, asciiMessages = false } = {}) {
  if (!isPlainObject(rawBody)) {
    return { error: asciiMessages ? 'Dados da tarefa invalidos.' : 'Dados da tarefa inválidos.' };
  }

  const { title, description, discipline_id, due_date, priority } = rawBody;

  if (typeof title !== 'string' || !title.trim()) {
    return { error: asciiMessages ? 'Informe o titulo da tarefa.' : 'Informe o título da tarefa.' };
  }
  const cleanTitle = title.trim();
  if (cleanTitle.length > MAX_TASK_TITLE_LENGTH) {
    return { error: `O título da tarefa deve ter no máximo ${MAX_TASK_TITLE_LENGTH} caracteres.` };
  }

  if (description != null && typeof description !== 'string') {
    return { error: asciiMessages ? 'Descricao invalida.' : 'Descrição inválida.' };
  }
  const cleanDescription = typeof description === 'string' ? description.trim() : '';
  if (cleanDescription.length > MAX_TASK_DESCRIPTION_LENGTH) {
    return { error: `A descrição deve ter no máximo ${MAX_TASK_DESCRIPTION_LENGTH} caracteres.` };
  }

  const resolvedPriority = !requirePriority && priority === undefined ? 'Média' : priority;
  if (!['Baixa', 'Média', 'Alta'].includes(resolvedPriority)) {
    return { error: asciiMessages ? 'Prioridade invalida.' : 'Prioridade inválida.' };
  }

  const prazo = due_date === undefined || due_date === null || due_date === '' ? null : due_date;
  if (prazo !== null) {
    if (typeof prazo !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(prazo)) {
      return { error: asciiMessages ? 'Prazo invalido.' : 'Prazo inválido.' };
    }
    const date = new Date(`${prazo}T00:00:00Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== prazo) {
      return { error: 'Data inexistente.' };
    }
  }

  let disciplineId = null;
  if (discipline_id !== null && discipline_id !== undefined && discipline_id !== '') {
    if (typeof discipline_id !== 'number' && typeof discipline_id !== 'string') {
      return { error: asciiMessages ? 'Disciplina invalida.' : 'Disciplina inválida.' };
    }
    disciplineId = parsePositiveId(discipline_id);
    if (!disciplineId) {
      return { error: asciiMessages ? 'Disciplina invalida.' : 'Disciplina inválida.' };
    }
  }

  return {
    value: {
      title: cleanTitle,
      description: cleanDescription,
      disciplineId,
      dueDate: prazo,
      priority: resolvedPriority
    }
  };
}

function sendRateLimitExceeded(res, retryAfterSeconds, message) {
  res.setHeader('Retry-After', String(retryAfterSeconds));
  return res.status(429).json({ error: message });
}

function handleCryptoError(err, res, fallbackMessage) {
  if (err instanceof CryptoBusyError || (err && err.name === 'CryptoBusyError')) {
    res.setHeader('Retry-After', String(err.retryAfterSeconds || 2));
    return res.status(503).json({ error: err.message });
  }
  return res.status(500).json({ error: fallbackMessage });
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;
    const session = await validateSession(db, token);

    if (!session) {
      return res.status(401).json({ error: 'Usuário não autenticado.' });
    }

    req.userId = session.userId;
    req.sessionId = session.sessionId;
    req.tokenHash = session.tokenHash;
    next();
  } catch {
    return res.status(500).json({ error: 'Erro ao validar sessão.' });
  }
}

app.post('/api/register', async (req, res) => {
  try {
    const clientIp = getClientIp(req, { trustProxy });
    const ipLimit = await consumeRateLimit(db, {
      scope: 'register:ip',
      identifier: clientIp,
      maxAttempts: rateLimitConfig.registerMax,
      windowMs: rateLimitConfig.windowMs,
      blockMs: rateLimitConfig.blockMs
    });
    if (!ipLimit.allowed) {
      return sendRateLimitExceeded(
        res,
        ipLimit.retryAfterSeconds,
        'Muitas tentativas de cadastro. Aguarde antes de tentar novamente.'
      );
    }

    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Dados de cadastro inválidos.' });
    }

    const { name, email, password } = req.body;
    if (
      typeof name !== 'string' || !name.trim() ||
      typeof email !== 'string' || !email.trim() ||
      typeof password !== 'string' || !password
    ) {
      return res.status(400).json({ error: 'Preencha nome, e-mail e senha.' });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanName.length > MAX_NAME_LENGTH) {
      return res.status(400).json({ error: `O nome deve ter no máximo ${MAX_NAME_LENGTH} caracteres.` });
    }
    if (cleanEmail.length > MAX_EMAIL_LENGTH || !EMAIL_REGEX.test(cleanEmail)) {
      return res.status(400).json({ error: 'Informe um e-mail válido.' });
    }

    const passwordCheck = passwordManager.validatePasswordStrength(password);
    if (!passwordCheck.valid) {
      return res.status(400).json({ error: passwordCheck.error });
    }

    const passwordHash = await passwordManager.hashPassword(password);
    cleanupExpiredRateLimits(db).catch(() => {});

    db.run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [cleanName, cleanEmail, passwordHash],
      function (err) {
        if (err) {
          if (isUniqueConstraintError(err)) {
            return res.status(409).json({ error: 'Este e-mail já está cadastrado.' });
          }
          return res.status(500).json({ error: 'Erro ao cadastrar usuário.' });
        }
        res.status(201).json({ message: 'Cadastro realizado com sucesso.' });
      }
    );
  } catch (err) {
    return handleCryptoError(err, res, 'Erro ao cadastrar usuário.');
  }
});

app.post('/api/login', async (req, res) => {
  try {
    const clientIp = getClientIp(req, { trustProxy });
    const ipLimit = await consumeRateLimit(db, {
      scope: 'login:ip',
      identifier: clientIp,
      maxAttempts: rateLimitConfig.loginMax,
      windowMs: rateLimitConfig.windowMs,
      blockMs: rateLimitConfig.blockMs
    });
    if (!ipLimit.allowed) {
      return sendRateLimitExceeded(
        res,
        ipLimit.retryAfterSeconds,
        'Muitas tentativas de login. Aguarde antes de tentar novamente.'
      );
    }

    if (!isPlainObject(req.body)) {
      return res.status(400).json({ error: 'Informe e-mail e senha.' });
    }

    const { email, password } = req.body;
    if (
      typeof email !== 'string' || !email.trim() ||
      typeof password !== 'string' || !password
    ) {
      return res.status(400).json({ error: 'Informe e-mail e senha.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    if (cleanEmail.length > MAX_EMAIL_LENGTH || password.length > passwordManager.MAX_PASSWORD_LENGTH) {
      return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
    }

    const accountLimit = await consumeRateLimit(db, {
      scope: 'login:acct',
      identifier: cleanEmail,
      maxAttempts: rateLimitConfig.loginAccountMax,
      windowMs: rateLimitConfig.windowMs,
      blockMs: rateLimitConfig.blockMs
    });
    if (!accountLimit.allowed) {
      return sendRateLimitExceeded(
        res,
        accountLimit.retryAfterSeconds,
        'Muitas tentativas de login. Aguarde antes de tentar novamente.'
      );
    }

    db.get(
      'SELECT id, name, email, password_hash FROM users WHERE email = ?',
      [cleanEmail],
      async (err, user) => {
        if (err) return res.status(500).json({ error: 'Erro interno.' });
        try {
          if (!user) {
            await passwordManager.verifyDummyPassword();
            return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
          }

          const passwordMatches = await passwordManager.verifyPassword(password, user.password_hash);
          if (!passwordMatches) {
            return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
          }

          await resetRateLimit(db, { scope: 'login:acct', identifier: cleanEmail }).catch(() => {});
          cleanupExpiredRateLimits(db).catch(() => {});

          const session = await createSession(db, user.id, { ttlMs: sessionTtlMs });
          return res.json({
            token: session.token,
            user: { id: user.id, name: user.name, email: user.email }
          });
        } catch (cryptoOrSessionErr) {
          return handleCryptoError(cryptoOrSessionErr, res, 'Erro interno.');
        }
      }
    );
  } catch (err) {
    return handleCryptoError(err, res, 'Erro interno.');
  }
});

app.post('/api/logout', auth, async (req, res) => {
  try {
    await revokeSession(db, {
      sessionId: req.sessionId,
      userId: req.userId,
      tokenHash: req.tokenHash
    });
    return res.json({ message: 'Sessão encerrada.' });
  } catch {
    return res.status(500).json({ error: 'Erro ao encerrar sessão.' });
  }
});

app.get('/api/dashboard', auth, (req, res) => {
  db.all(
    `WITH task_metrics AS (
       SELECT
         CAST(COUNT(*) AS INTEGER) AS total,
         CAST(COALESCE(SUM(CASE WHEN status = 'Concluída' THEN 1 ELSE 0 END), 0) AS INTEGER) AS completed,
         CAST(COALESCE(SUM(CASE WHEN status = 'Pendente' THEN 1 ELSE 0 END), 0) AS INTEGER) AS pending
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
       CASE WHEN t.due_date IS NULL THEN 0 ELSE 1 END,
       t.due_date ASC,
       t.id ASC`,
    [req.userId, req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao carregar dashboard.' });
      const row = rows[0] || {};
      const total = Number(row.total ?? 0);
      const completed = Number(row.completed ?? 0);
      const pending = Number(row.pending ?? 0);
      const productivity = total > 0 ? Math.round((completed / total) * 100) : 0;
      const tasks = rows
        .filter(item => item.id !== null && item.id !== undefined)
        .map(item => ({
          id: Number(item.id),
          title: item.title,
          status: item.status,
          priority: item.priority,
          due_date: item.due_date,
          discipline_id: item.discipline_id == null ? null : Number(item.discipline_id),
          discipline_name: item.discipline_name
        }));
      res.json({ total, completed, pending, productivity, tasks });
    }
  );
});

app.get('/api/disciplines', auth, (req, res) => {
  db.all(
    'SELECT id, name, created_at FROM disciplines WHERE user_id = ? ORDER BY name, id ASC',
    [req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao listar disciplinas.' });
      res.json(rows);
    }
  );
});

app.post('/api/disciplines', auth, (req, res) => {
  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: 'Informe o nome da disciplina.' });
  }
  const { name } = req.body;
  if (typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'Informe o nome da disciplina.' });
  }
  const cleanName = name.trim();
  if (cleanName.length > MAX_NAME_LENGTH) {
    return res.status(400).json({ error: `O nome da disciplina deve ter no máximo ${MAX_NAME_LENGTH} caracteres.` });
  }

  db.run(
    'INSERT INTO disciplines (user_id, name) VALUES (?, ?)',
    [req.userId, cleanName],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao cadastrar disciplina.' });
      res.status(201).json({ id: this.lastID, name: cleanName });
    }
  );
});

app.delete('/api/disciplines/:id', auth, (req, res) => {
  const disciplineId = parsePositiveId(req.params.id);
  if (!disciplineId) {
    return res.status(400).json({ error: 'ID da disciplina inválido.' });
  }

  db.run(
    'DELETE FROM disciplines WHERE id = ? AND user_id = ?',
    [disciplineId, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao excluir disciplina.' });
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Disciplina não encontrada.' });
      }
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
       CASE WHEN t.due_date IS NULL THEN 0 ELSE 1 END,
       t.due_date ASC,
       t.id ASC`,
    [req.userId],
    (err, rows) => {
      if (err) return res.status(500).json({ error: 'Erro ao listar tarefas.' });
      res.json(rows);
    }
  );
});

app.post('/api/tasks', auth, (req, res) => {
  const parsed = validateTaskPayload(req.body, { requirePriority: false, asciiMessages: false });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { title, description, disciplineId, dueDate, priority } = parsed.value;

  // Preserva a criação de tarefas sem disciplina, existente na V0.
  function insertTask(verifiedDisciplineId) {
    db.run(
      `INSERT INTO tasks
        (user_id, discipline_id, title, description, due_date, priority, status)
       VALUES (?, ?, ?, ?, ?, ?, 'Pendente')`,
      [
        req.userId,
        verifiedDisciplineId,
        title,
        description,
        dueDate,
        priority
      ],
      function (err) {
        if (err) {
          if (isForeignKeyError(err)) {
            return res.status(404).json({ error: 'Disciplina não encontrada para este usuário.' });
          }
          return res.status(500).json({ error: 'Erro ao cadastrar tarefa.' });
        }
        res.status(201).json({ id: this.lastID, message: 'Tarefa cadastrada.' });
      }
    );
  }

  if (disciplineId === null) {
    return insertTask(null);
  }

  // Validação de propriedade antes de associar tarefa e disciplina.
  db.get(
    'SELECT id FROM disciplines WHERE id = ? AND user_id = ?',
    [disciplineId, req.userId],
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
  const taskId = parsePositiveId(req.params.id);

  if (!taskId) {
    return res.status(400).json({ error: 'ID da tarefa invalido.' });
  }

  const parsed = validateTaskPayload(req.body, { requirePriority: true, asciiMessages: true });
  if (parsed.error) {
    return res.status(400).json({ error: parsed.error });
  }
  const { title, description, disciplineId, dueDate, priority } = parsed.value;

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
            title,
            description,
            verifiedDisciplineId,
            dueDate,
            priority,
            taskId,
            req.userId
          ],
          function (updateError) {
            if (updateError) {
              if (isForeignKeyError(updateError)) {
                return res.status(404).json({
                  error: 'Disciplina nao encontrada para este usuario.'
                });
              }
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
  const taskId = parsePositiveId(req.params.id);
  if (!taskId) {
    return res.status(400).json({ error: 'ID da tarefa inválido.' });
  }

  if (!isPlainObject(req.body)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const { status } = req.body;
  if (!['Pendente', 'Concluída'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  db.run(
    'UPDATE tasks SET status = ? WHERE id = ? AND user_id = ?',
    [status, taskId, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao atualizar tarefa.' });
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Tarefa não encontrada.' });
      }
      res.json({ message: 'Status atualizado.' });
    }
  );
});

app.delete('/api/tasks/:id', auth, (req, res) => {
  const taskId = parsePositiveId(req.params.id);
  if (!taskId) {
    return res.status(400).json({ error: 'ID da tarefa inválido.' });
  }

  db.run(
    'DELETE FROM tasks WHERE id = ? AND user_id = ?',
    [taskId, req.userId],
    function (err) {
      if (err) return res.status(500).json({ error: 'Erro ao excluir tarefa.' });
      if (this.changes === 0) {
        return res.status(404).json({ error: 'Tarefa não encontrada.' });
      }
      res.json({ message: 'Tarefa excluída.' });
    }
  );
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Endpoint da API não encontrado.' });
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.use((err, req, res, next) => {
  if (!err) return next();
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Corpo da requisição excede o limite permitido.' });
  }
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({ error: 'JSON inválido na requisição.' });
  }
  if (err instanceof CryptoBusyError || err.name === 'CryptoBusyError') {
    res.setHeader('Retry-After', String(err.retryAfterSeconds || 2));
    return res.status(503).json({ error: err.message });
  }
  return res.status(500).json({ error: 'Erro interno do servidor.' });
});

app.db = db;

if (typeof module !== 'undefined' && module.exports) {
  module.exports = app;
}

const runningInTestVm = typeof module === 'undefined';
if (runningInTestVm || require.main === module) {
  app.listen(PORT, () => {
    console.log(`Servidor iniciado em http://localhost:${PORT}`);
  });
}
