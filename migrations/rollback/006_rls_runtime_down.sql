-- Reverte exclusivamente as policies adicionadas pela 006; nao remove dados.
-- A reversao restaura as limitacoes anteriores de RLS. Coordenar com o codigo.
BEGIN;
DROP POLICY IF EXISTS rls006_users_select ON public.users;
DROP POLICY IF EXISTS rls006_users_insert ON public.users;
DROP POLICY IF EXISTS rls006_users_update ON public.users;
DROP POLICY IF EXISTS rls006_disciplines ON public.disciplines;
DROP POLICY IF EXISTS rls006_tasks ON public.tasks;
DROP POLICY IF EXISTS rls006_sessions_select ON public.sessions;
DROP POLICY IF EXISTS rls006_sessions_insert ON public.sessions;
DROP POLICY IF EXISTS rls006_sessions_update ON public.sessions;
DROP POLICY IF EXISTS rls006_sessions_delete ON public.sessions;
REVOKE UPDATE (revoked_at) ON public.sessions FROM organiza_app;
GRANT UPDATE ON public.sessions TO organiza_app;
COMMIT;
