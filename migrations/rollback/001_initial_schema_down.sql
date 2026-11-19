-- Rollback da Migration 001: remove tabelas e indices criados no schema inicial
-- ATENCAO: operacao destrutiva; executar apenas em ambiente descartavel ou apos backup pg_dump.

BEGIN;

DROP TABLE IF EXISTS public.tasks;
DROP TABLE IF EXISTS public.disciplines;
DROP TABLE IF EXISTS public.users;

COMMIT;
