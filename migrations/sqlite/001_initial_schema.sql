-- Organiza+ — SQLite Migration 001: Schema inicial equivalente ao PostgreSQL

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS disciplines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL,
  discipline_id INTEGER,
  title TEXT NOT NULL,
  description TEXT,
  due_date TEXT,
  priority TEXT DEFAULT 'Média',
  status TEXT DEFAULT 'Pendente',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY(discipline_id) REFERENCES disciplines(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_disciplines_user_name
  ON disciplines (user_id, name, id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_id
  ON tasks (user_id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_discipline
  ON tasks (user_id, discipline_id);

CREATE INDEX IF NOT EXISTS idx_tasks_user_default_order
  ON tasks (user_id, status, priority, due_date, id);

CREATE TRIGGER IF NOT EXISTS trg_tasks_discipline_owner_insert
BEFORE INSERT ON tasks
FOR EACH ROW
WHEN NEW.discipline_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM disciplines d
    WHERE d.id = NEW.discipline_id AND d.user_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'CROSS_USER_DISCIPLINE');
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_discipline_owner_update
BEFORE UPDATE OF discipline_id, user_id ON tasks
FOR EACH ROW
WHEN NEW.discipline_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM disciplines d
    WHERE d.id = NEW.discipline_id AND d.user_id = NEW.user_id
  )
BEGIN
  SELECT RAISE(ABORT, 'CROSS_USER_DISCIPLINE');
END;
