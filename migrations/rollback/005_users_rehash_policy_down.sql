-- Rollback da Migration 005: remove politica e privilegio UPDATE (password_hash) da role organiza_app em users

BEGIN;

DROP POLICY IF EXISTS users_runtime_update ON public.users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organiza_app') THEN
    REVOKE UPDATE ON TABLE public.users FROM organiza_app;
  END IF;
END
$$;

COMMIT;
