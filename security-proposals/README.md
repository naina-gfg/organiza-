# RLS e homologação operacional

A migration `migrations/006_rls_runtime.sql` acrescenta policies restritivas às policies permissivas históricas. Disciplinas e tarefas exigem identidade. Usuários são consultados pelo e-mail no cadastro/login e pelo ID validado após autenticação. Sessões são consultadas pelo hash do token ou pelo usuário validado. A limpeza só alcança sessões expiradas ou revogadas há pelo menos 24 horas. O runtime só pode atualizar a coluna `revoked_at` das sessões. Limites de tentativas são acessados antes do login e usam chaves derivadas por hash.

O adaptador inicia uma transação curta para cada consulta PostgreSQL, zera os quatro contextos e estabelece o necessário com `set_config(..., true)` no mesmo cliente. Faz commit ou rollback antes de liberar a conexão e descarta o cliente se o rollback falhar. O ID de usuário é obtido da sessão validada, nunca de parâmetros HTTP. Cada consulta é uma transação independente: sequências de consultas não são uma única operação atômica. Não há prepared statements nomeados, para compatibilidade com pool em modo de transação.

O contexto é uma informação fornecida pelo servidor de aplicação. Uma pessoa com a credencial direta da role de runtime ou capaz de executar SQL arbitrário pode definir esses parâmetros; RLS com GUCs não substitui a proteção da credencial, consultas parametrizadas ou autorização no servidor. Roles proprietárias das tabelas, superusuários e roles com BYPASSRLS podem ignorar RLS. A role real precisa ser `organiza_app` ou outra role cuidadosamente avaliada com as mesmas policies e sem bypass. Confirme também heranças, grants de coluna, policies extras, ownership e privilégios de esquemas.

Cadastro/login exigem consulta restrita por e-mail antes da identidade; sessão exige consulta pelo hash do token antes de conhecer o usuário. A criação da sessão e o rehash usam o ID somente após validação da senha. `rate_limits` mantém o acesso operacional para a atualização atômica e a limpeza anteriores à autenticação. Não existem funções SECURITY DEFINER nesta solução.

## Homologação no ambiente existente

1. Identifique projeto, banco, deployment, configuração TLS e role efetiva sem divulgar credenciais. Inspecione esquema, cinco migrations, grants, memberships e policies existentes. Faça backup e confirme restore e deployment anterior.
2. Em ambiente de homologação isolado que espelhe os dados e a configuração relevantes, instale primeiro o código compatível e valide a operação com as policies antigas. A mudança do banco antes do código impede operações autenticadas do código anterior.
3. Após revisão operacional e autorização apropriada, aplique 006 com role migradora. Confirme a role de runtime não proprietária e sem superuser/BYPASSRLS. Verifique cadastro, login, sessão, expiração, logout, limpeza, concorrência, CRUD e isolamento entre duas contas com Supavisor real. Confirme que nenhuma policy ou grant inesperado contorna os resultados.
4. Monitore erros, tempos de resposta e conexões. Cada consulta agora usa uma transação e comandos de contexto adicionais, o que pode aumentar latência. Nenhum teste local demonstra o estado ou desempenho do banco remoto.

## Reversão

`migrations/rollback/006_rls_runtime_down.sql` remove somente as policies da 006 e restaura o grant de UPDATE em sessões da baseline 004. Execute apenas depois de verificar que esses grants correspondem ao estado anterior real. O rollback devolve a limitação anterior de isolamento quando falta contexto. Em reversão coordenada, reverta 006 antes de retornar ao código antigo; valide o fluxo e preserve dados. Não execute os rollbacks históricos automaticamente.

`rls-domain-draft.sql` e `rls-transaction.cjs` são o experimento anterior e não integram o runtime nem o artefato Vercel.
