# Organiza+

Aplicação web para organização acadêmica, gerenciamento de disciplinas, tarefas, filtros/ordenação de prazos e dashboard analítico.

## Estado atual (Baseline PROD-02A)

Esta cópia independente foi preparada para futura implantação em produção (GitHub + Supabase PostgreSQL + Vercel Hobby), preservando integralmente as funcionalidades homologadas até o **FUNC-04B + BUGFIX-04-01** e os **31 testes automatizados** existentes.

> **Nota:** Nesta etapa (`PROD-02A`), a aplicação ainda utiliza **SQLite local** (`backend/plataforma.db`, ignorado pelo Git) e autenticação em memória para execução local controlada. A adaptação para PostgreSQL e sessões compatíveis com Vercel Functions ocorrerá na etapa seguinte (`PROD-02B`).

## Requisitos

- Node.js 20+ (validado com Node.js v24.19.0)
- npm 10+

## Instalação

```bash
npm ci
```

## Execução local

```bash
npm start
```

Por padrão, o servidor sobe em `http://localhost:3000`. Para usar outra porta (por exemplo `3200`), defina `PORT`:

```powershell
$env:PORT=3200; npm start
```

## Testes automatizados

```bash
npm test
```

Os testes executam em modo isolado com mocks e SQLite em memória (`:memory:`), sem alterar o banco local.

## Estrutura do projeto

- `backend/` — servidor Express e camada de acesso SQLite (`server.js`, `database.js`)
- `frontend/` — interface web estática (HTML, CSS e JavaScript Vanilla)
- `tests/` — suítes automatizadas (`seg01`, `func02`, `func03`, `func04`)
