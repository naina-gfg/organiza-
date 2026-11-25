-- Policies restritivas complementam as policies permissivas historicas.
-- Aplicar somente apos validar runtime, grants, roles e policies efetivos.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'organiza_app' AND NOT rolsuper AND NOT rolbypassrls) THEN
    RAISE EXCEPTION 'organiza_app ausente ou possui privilegios de bypass RLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_roles r
    WHERE r.rolname <> 'organiza_app' AND (r.rolsuper OR r.rolbypassrls)
      AND pg_has_role('organiza_app', r.rolname, 'MEMBER')
  ) THEN
    RAISE EXCEPTION 'organiza_app pertence a role administrativa ou com bypass RLS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_roles r ON r.oid = c.relowner
    WHERE n.nspname = 'public' AND c.relname IN ('users','sessions','disciplines','tasks','rate_limits')
      AND (NOT c.relrowsecurity OR pg_has_role('organiza_app', r.rolname, 'MEMBER'))
  ) THEN
    RAISE EXCEPTION 'RLS ausente ou role de runtime proprietaria de tabela';
  END IF;
END $$;

-- O runtime apenas revoga sessoes; nao deve alterar proprietario ou hash do token.
REVOKE UPDATE ON public.sessions FROM organiza_app;
GRANT UPDATE (revoked_at) ON public.sessions TO organiza_app;

CREATE POLICY rls006_users_select ON public.users AS RESTRICTIVE FOR SELECT TO organiza_app
  USING (email = NULLIF(current_setting('app.lookup_email', true), '')
      OR id::text = NULLIF(current_setting('app.current_user_id', true), ''));
CREATE POLICY rls006_users_insert ON public.users AS RESTRICTIVE FOR INSERT TO organiza_app
  WITH CHECK (email = NULLIF(current_setting('app.lookup_email', true), ''));
CREATE POLICY rls006_users_update ON public.users AS RESTRICTIVE FOR UPDATE TO organiza_app
  USING (id::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK (id::text = NULLIF(current_setting('app.current_user_id', true), ''));

CREATE POLICY rls006_disciplines ON public.disciplines AS RESTRICTIVE FOR ALL TO organiza_app
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
CREATE POLICY rls006_tasks ON public.tasks AS RESTRICTIVE FOR ALL TO organiza_app
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));

CREATE POLICY rls006_sessions_select ON public.sessions AS RESTRICTIVE FOR SELECT TO organiza_app
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), '')
      OR token_hash = NULLIF(current_setting('app.session_token_hash', true), '')
      OR (current_setting('app.session_cleanup', true) = '1'
          AND (expires_at <= statement_timestamp()
            OR (revoked_at IS NOT NULL AND revoked_at <= statement_timestamp() - interval '24 hours'))));
CREATE POLICY rls006_sessions_insert ON public.sessions AS RESTRICTIVE FOR INSERT TO organiza_app
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
CREATE POLICY rls006_sessions_update ON public.sessions AS RESTRICTIVE FOR UPDATE TO organiza_app
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), '')
      OR token_hash = NULLIF(current_setting('app.session_token_hash', true), ''))
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), '')
      OR token_hash = NULLIF(current_setting('app.session_token_hash', true), ''));
CREATE POLICY rls006_sessions_delete ON public.sessions AS RESTRICTIVE FOR DELETE TO organiza_app
  USING ((token_hash = NULLIF(current_setting('app.session_token_hash', true), '')
           OR current_setting('app.session_cleanup', true) = '1')
      AND (expires_at <= statement_timestamp()
        OR (revoked_at IS NOT NULL AND revoked_at <= statement_timestamp() - interval '24 hours')));

-- rate_limits nao contem dados de conteudo do usuario: chaves sao hashes e as
-- operacoes atomicas pre-autenticacao e limpeza precisam de acesso operacional.
COMMIT;
