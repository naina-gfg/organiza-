-- Organiza+ — Migration 005: Permissao minima de atualizacao do hash de senha (rehash transparente)
-- Executar exclusivamente com role administrativa/migradora (ex.: via DIRECT_URL).
-- Concede a role organiza_app apenas UPDATE na coluna password_hash para upgrade de parametros scrypt apos login valido.

BEGIN;

GRANT UPDATE (password_hash) ON TABLE public.users TO organiza_app;

DROP POLICY IF EXISTS users_runtime_update ON public.users;
CREATE POLICY users_runtime_update
  ON public.users
  FOR UPDATE
  TO organiza_app
  USING (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  )
  WITH CHECK (
    NULLIF(current_setting('app.current_user_id', true), '') IS NULL
    OR id = CASE
      WHEN NULLIF(current_setting('app.current_user_id', true), '') ~ '^[0-9]+$'
        THEN NULLIF(current_setting('app.current_user_id', true), '')::integer
      ELSE -1
    END
  );

COMMIT;
