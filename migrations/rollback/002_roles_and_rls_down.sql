-- Rollback da Migration 002: remove politicas RLS, revoga grants da role de runtime e desativa RLS

BEGIN;

DROP POLICY IF EXISTS tasks_runtime_delete ON public.tasks;
DROP POLICY IF EXISTS tasks_runtime_update ON public.tasks;
DROP POLICY IF EXISTS tasks_runtime_insert ON public.tasks;
DROP POLICY IF EXISTS tasks_runtime_select ON public.tasks;

DROP POLICY IF EXISTS disciplines_runtime_delete ON public.disciplines;
DROP POLICY IF EXISTS disciplines_runtime_insert ON public.disciplines;
DROP POLICY IF EXISTS disciplines_runtime_select ON public.disciplines;

DROP POLICY IF EXISTS users_runtime_insert ON public.users;
DROP POLICY IF EXISTS users_runtime_select ON public.users;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organiza_app') THEN
    REVOKE ALL ON TABLE public.users, public.disciplines, public.tasks FROM organiza_app;
    REVOKE ALL ON SEQUENCE public.users_id_seq, public.disciplines_id_seq, public.tasks_id_seq FROM organiza_app;
    REVOKE USAGE ON SCHEMA public FROM organiza_app;
  END IF;
END
$$;

ALTER TABLE IF EXISTS public.tasks DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.disciplines DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.users DISABLE ROW LEVEL SECURITY;

COMMIT;
