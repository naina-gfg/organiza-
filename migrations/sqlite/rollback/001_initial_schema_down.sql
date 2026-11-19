-- Rollback SQLite Migration 001

DROP TRIGGER IF EXISTS trg_tasks_discipline_owner_update;
DROP TRIGGER IF EXISTS trg_tasks_discipline_owner_insert;
DROP TABLE IF EXISTS tasks;
DROP TABLE IF EXISTS disciplines;
DROP TABLE IF EXISTS users;
