# Organiza+

Aplicação web para organização acadêmica, gerenciamento de disciplinas, tarefas, filtros/ordenação de prazos e dashboard analítico.

## Estado da versão candidata

Esta versão candidata preserva a aplicação oficial de organização acadêmica. O visualizador e os módulos do laboratório são mantidos separadamente e não integram o artefato implantável.

O ambiente local pode usar SQLite. Em produção, a aplicação exige PostgreSQL e TLS com validação de certificado. Sessões e limites de tentativas são persistidos no banco. O cadastro aceita senhas de 6 a 128 caracteres e armazena hashes scrypt. A revisão de RLS e a homologação no ambiente real continuam necessárias antes de qualquer publicação.

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

As suítes utilizam bancos SQLite e PostgreSQL temporários, mocks e navegador local conforme o caso. A suíte PostgreSQL/Vercel requer binários locais de PostgreSQL, OpenSSL e Chromium ou Edge. Não configure essas suítes para um banco de produção.

## Estrutura do projeto

- `backend/` — servidor Express e adaptadores SQLite/PostgreSQL (`server.js`, `database.js`)
- `frontend/` — interface web estática (HTML, CSS e JavaScript Vanilla)
- `tests/` — suítes automatizadas de funcionalidade, segurança e integração
- `security-proposals/` — experimentos locais de segurança, excluídos da implantação
