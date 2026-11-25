# Protótipo local de RLS

Este diretório está excluído do deploy. O SQL é um experimento, não uma migration pronta para produção. Ele fecha o acesso sem contexto apenas em disciplinas e tarefas. O helper demonstra identidade validada em uma transação no mesmo cliente do pool, com `set_config(..., true)` limitado à transação, rollback em erro e descarte da conexão se o rollback falhar. A aplicação oficial ainda não utiliza esse helper.

Não aplicar o SQL isoladamente: a aplicação atual não define o contexto e deixaria de acessar disciplinas e tarefas. O contexto deve ser derivado somente da sessão validada pelo servidor e nunca de um identificador fornecido diretamente pelo cliente. Roles proprietárias, superusuários e roles com BYPASSRLS podem contornar RLS.

Antes de propor migration, integrar e testar todo o ciclo de requisição e a associação entre transação e conexão, inclusive concorrência, falhas, limpeza de tarefas em background e Supavisor. O cadastro e o login precisam consultar usuários antes da identificação. Sessões precisam localizar o hash de um token antes de identificar seu titular e executar limpeza e revogação. As policies existentes dessas tabelas ainda admitem contexto ausente. Projetar operações restritas específicas para esses casos, avaliar grants e usuários efetivos e testar sem privilégios de bypass. O protótipo não comprova isolamento dessas tabelas.

Reversão do experimento: em banco descartável, restaurar as policies de disciplinas e tarefas da migration 002. Em ambiente real, preparar rollback específico e versionado após inspecionar o esquema efetivo, testar num clone e coordenar o código e as policies. Não executar o rollback genérico da migration 002, pois ele revoga grants e desativa RLS.
