-- Organiza+ — Migration 002: Role de runtime de privilegios minimos, permissoes restritivas e RLS
-- Executar exclusivamente com role administrativa/migradora.
-- IMPORTANTE:
--   1. Este arquivo nao define senhas literais. Antes de conectar a aplicacao em runtime,
--      o operador deve habilitar login e definir senha forte fora do repositorio:
--      ALTER ROLE organiza_app WITH LOGIN PASSWORD '<SENHA_FORTE_GERADA>';
--   2. No modelo atual de autenticacao propria do Express (Bearer token em memoria/sessao da API),
--      habilitar RLS isoladamente NAO garante autorizacao por usuario na aplicacao:
--      - RLS + REVOKE bloqueiam integralmente acesso publico (PUBLIC, anon, authenticated).
--      - O isolamento entre contas nas rotas Express continua obrigatorio via WHERE user_id = $1
--        e pela FK composta (discipline_id, user_id) no banco.

BEGIN;

-- 1. Ativa Row Level Security nas tres tabelas
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.disciplines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tasks ENABLE ROW LEVEL SECURITY;

-- 2. Revoga qualquer privilegio padrao publico e da Data API do Supabase (se existir)
REVOKE ALL ON TABLE public.users, public.disciplines, public.tasks FROM PUBLIC;
REVOKE ALL ON SEQUENCE public.users_id_seq, public.disciplines_id_seq, public.tasks_id_seq FROM PUBLIC;

DO $$
DECLARE
  role_name TEXT;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON TABLE public.users, public.disciplines, public.tasks FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON SEQUENCE public.users_id_seq, public.disciplines_id_seq, public.tasks_id_seq FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;

-- 3. Cria role de runtime sem privilegios administrativos (distinta da role de migrations)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organiza_app') THEN
    CREATE ROLE organiza_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

-- 4. Concede apenas os privilegios DML minimos necessarios as 14 operacoes da API
GRANT USAGE ON SCHEMA public TO organiza_app;

-- users: cadastro (INSERT) e login (SELECT); sem UPDATE/DELETE/TRUNCATE
GRANT SELECT, INSERT ON TABLE public.users TO organiza_app;

-- disciplines: listagem (SELECT), criacao (INSERT) e exclusao (DELETE); sem UPDATE/TRUNCATE
GRANT SELECT, INSERT, DELETE ON TABLE public.disciplines TO organiza_app;

-- tasks: listagem/dashboard (SELECT), criacao (INSERT), edicao/status (UPDATE) e exclusao (DELETE); sem TRUNCATE
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.tasks TO organiza_app;

GRANT USAGE, SELECT ON SEQUENCE public.users_id_seq, public.disciplines_id_seq, public.tasks_id_seq TO organiza_app;

-- 5. Politicas RLS restritivas: ZERO politicas para PUBLIC, anon ou authenticated.
--    Politicas aplicadas exclusivamente a role de runtime organiza_app.
DROP POLICY IF EXISTS users_runtime_select ON public.users;
CREATE POLICY users_runtime_select
  ON public.users
  FOR SELECT
  TO organiza_app
  USING (true);

DROP POLICY IF EXISTS users_runtime_insert ON public.users;
CREATE POLICY users_runtime_insert
  ON public.users
  FOR INSERT
  TO organiza_app
  WITH CHECK (true);

DROP POLICY IF EXISTS disciplines_runtime_select ON public.disciplines;
CREATE POLICY disciplines_runtime_select
  ON public.disciplines
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

DROP POLICY IF EXISTS disciplines_runtime_insert ON public.disciplines;
CREATE POLICY disciplines_runtime_insert
  ON public.disciplines
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

DROP POLICY IF EXISTS disciplines_runtime_delete ON public.disciplines;
CREATE POLICY disciplines_runtime_delete
  ON public.disciplines
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

DROP POLICY IF EXISTS tasks_runtime_select ON public.tasks;
CREATE POLICY tasks_runtime_select
  ON public.tasks
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

DROP POLICY IF EXISTS tasks_runtime_insert ON public.tasks;
CREATE POLICY tasks_runtime_insert
  ON public.tasks
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

DROP POLICY IF EXISTS tasks_runtime_update ON public.tasks;
CREATE POLICY tasks_runtime_update
  ON public.tasks
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

DROP POLICY IF EXISTS tasks_runtime_delete ON public.tasks;
CREATE POLICY tasks_runtime_delete
  ON public.tasks
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

COMMIT;
