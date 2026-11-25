-- EXPERIMENTO LOCAL: nao e migration e nao deve ser aplicado em producao.
-- Exige integracao de contexto transacional na aplicacao antes de qualquer rollout.
BEGIN;
ALTER POLICY disciplines_runtime_select ON public.disciplines
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY disciplines_runtime_insert ON public.disciplines
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY disciplines_runtime_delete ON public.disciplines
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY tasks_runtime_select ON public.tasks
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY tasks_runtime_insert ON public.tasks
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY tasks_runtime_update ON public.tasks
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''))
  WITH CHECK (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
ALTER POLICY tasks_runtime_delete ON public.tasks
  USING (user_id::text = NULLIF(current_setting('app.current_user_id', true), ''));
COMMIT;
