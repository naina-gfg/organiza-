-- Rollback da Migration 003: remove tabelas sessions e rate_limits

BEGIN;

DROP TABLE IF EXISTS public.rate_limits;
DROP TABLE IF EXISTS public.sessions;

COMMIT;
