-- Rollback da Migration 004: remove politicas RLS, revoga grants e desativa RLS de sessions e rate_limits

BEGIN;

DROP POLICY IF EXISTS rate_limits_runtime_delete ON public.rate_limits;
DROP POLICY IF EXISTS rate_limits_runtime_update ON public.rate_limits;
DROP POLICY IF EXISTS rate_limits_runtime_insert ON public.rate_limits;
DROP POLICY IF EXISTS rate_limits_runtime_select ON public.rate_limits;

DROP POLICY IF EXISTS sessions_runtime_delete ON public.sessions;
DROP POLICY IF EXISTS sessions_runtime_update ON public.sessions;
DROP POLICY IF EXISTS sessions_runtime_insert ON public.sessions;
DROP POLICY IF EXISTS sessions_runtime_select ON public.sessions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organiza_app') THEN
    REVOKE ALL ON TABLE public.sessions, public.rate_limits FROM organiza_app;
    REVOKE ALL ON SEQUENCE public.sessions_id_seq FROM organiza_app;
  END IF;
END
$$;

ALTER TABLE IF EXISTS public.rate_limits DISABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.sessions DISABLE ROW LEVEL SECURITY;

COMMIT;
