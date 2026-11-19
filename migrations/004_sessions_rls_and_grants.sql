-- Organiza+ — Migration 004: RLS e permissoes restritivas para sessions e rate_limits
-- Executar exclusivamente com role administrativa/migradora.
-- Mantem PUBLIC, anon e authenticated sem privilegios nem politicas.

BEGIN;

ALTER TABLE public.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rate_limits ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.sessions, public.rate_limits FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.sessions_id_seq FROM PUBLIC;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.sessions, public.rate_limits FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.sessions_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO organiza_app;
GRANT USAGE, SELECT ON SEQUENCE public.sessions_id_seq TO organiza_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.rate_limits TO organiza_app;

DROP POLICY IF EXISTS sessions_runtime_select ON public.sessions;
CREATE POLICY sessions_runtime_select
  ON public.sessions
  FOR SELECT
  TO organiza_app
  USING (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR user_id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  );

DROP POLICY IF EXISTS sessions_runtime_insert ON public.sessions;
CREATE POLICY sessions_runtime_insert
  ON public.sessions
  FOR INSERT
  TO organiza_app
  WITH CHECK (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR user_id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  );

DROP POLICY IF EXISTS sessions_runtime_update ON public.sessions;
CREATE POLICY sessions_runtime_update
  ON public.sessions
  FOR UPDATE
  TO organiza_app
  USING (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR user_id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR user_id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  );

DROP POLICY IF EXISTS sessions_runtime_delete ON public.sessions;
CREATE POLICY sessions_runtime_delete
  ON public.sessions
  FOR DELETE
  TO organiza_app
  USING (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR user_id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  );

DROP POLICY IF EXISTS rate_limits_runtime_select ON public.rate_limits;
CREATE POLICY rate_limits_runtime_select
  ON public.rate_limits
  FOR SELECT
  TO organiza_app
  USING (true);

DROP POLICY IF EXISTS rate_limits_runtime_insert ON public.rate_limits;
CREATE POLICY rate_limits_runtime_insert
  ON public.rate_limits
  FOR INSERT
  TO organiza_app
  WITH CHECK (true);

DROP POLICY IF EXISTS rate_limits_runtime_update ON public.rate_limits;
CREATE POLICY rate_limits_runtime_update
  ON public.rate_limits
  FOR UPDATE
  TO organiza_app
  USING (true)
  WITH CHECK (true);

DROP POLICY IF EXISTS rate_limits_runtime_delete ON public.rate_limits;
CREATE POLICY rate_limits_runtime_delete
  ON public.rate_limits
  FOR DELETE
  TO organiza_app
  USING (true);

COMMIT;
