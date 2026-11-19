'use strict';

const DML_KEYWORDS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE']);

function isIdentifierStart(ch) {
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || ch === '_';
}

function isIdentifierChar(ch) {
  return isIdentifierStart(ch) || (ch >= '0' && ch <= '9') || ch === '$';
}

function matchDollarTag(sql, index) {
  if (sql[index] !== '$') return null;
  let end = index + 1;
  if (end < sql.length && isIdentifierStart(sql[end])) {
    end += 1;
    while (end < sql.length && (isIdentifierStart(sql[end]) || (sql[end] >= '0' && sql[end] <= '9'))) {
      end += 1;
    }
  }
  if (end < sql.length && sql[end] === '$') {
    return sql.slice(index, end + 1);
  }
  return null;
}

/**
 * Traduz SQL parametrizado com placeholders `?` para `$1, $2, ...` respeitando
 * o contexto lexico SQL (strings simples, strings E'...', identificadores com aspas duplas,
 * dollar-quoting, comentarios de linha `--` e comentarios de bloco aninhados).
 * Para comandos INSERT em `db.run`, adiciona `RETURNING id` quando ausente.
 */
function translateSqlToPostgres(sql, options = {}) {
  if (typeof sql !== 'string') {
    throw new TypeError('A consulta SQL deve ser uma string.');
  }

  const { forRun = false } = options;
  let out = '';
  let paramIndex = 0;
  let hasPositionalPlaceholder = false;
  let hasNumberedPlaceholder = false;
  let parenDepth = 0;
  let firstKeyword = null;
  let topLevelDmlKeyword = null;
  let hasTopLevelReturning = false;
  let lastSignificantEnd = 0;
  let trailingSemicolonIndex = -1;

  let i = 0;
  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Comentario de linha -- ...
    if (ch === '-' && next === '-') {
      const start = i;
      i += 2;
      while (i < sql.length && sql[i] !== '\n') i += 1;
      out += sql.slice(start, i);
      continue;
    }

    // Comentario de bloco /* ... */ (com suporte a aninhamento do PostgreSQL)
    if (ch === '/' && next === '*') {
      const start = i;
      let depth = 1;
      i += 2;
      while (i < sql.length && depth > 0) {
        if (sql[i] === '/' && sql[i + 1] === '*') {
          depth += 1;
          i += 2;
        } else if (sql[i] === '*' && sql[i + 1] === '/') {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += sql.slice(start, i);
      continue;
    }

    // String com aspas simples (inclui escape estilo E'...' apenas quando precedido por E/e fora de identificador)
    if (ch === "'") {
      const prevChar = i > 0 ? sql[i - 1] : '';
      const beforePrev = i > 1 ? sql[i - 2] : '';
      const isEscapeString =
        (prevChar === 'e' || prevChar === 'E') && (!beforePrev || !isIdentifierChar(beforePrev));

      const start = i;
      i += 1;
      while (i < sql.length) {
        if (isEscapeString && sql[i] === '\\') {
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      lastSignificantEnd = out.length;
      continue;
    }

    // Identificador com aspas duplas "..."
    if (ch === '"') {
      const start = i;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += sql.slice(start, i);
      lastSignificantEnd = out.length;
      continue;
    }

    // Dollar-quoted string ($tag$...$tag$) ou placeholder numerado ($1)
    if (ch === '$') {
      const tag = matchDollarTag(sql, i);
      if (tag) {
        const closeIndex = sql.indexOf(tag, i + tag.length);
        if (closeIndex !== -1) {
          const end = closeIndex + tag.length;
          out += sql.slice(i, end);
          i = end;
          lastSignificantEnd = out.length;
          continue;
        }
      }
      if (next >= '1' && next <= '9') {
        hasNumberedPlaceholder = true;
      }
    }

    if (ch === '(') {
      parenDepth += 1;
      out += ch;
      i += 1;
      lastSignificantEnd = out.length;
      continue;
    }

    if (ch === ')') {
      if (parenDepth > 0) parenDepth -= 1;
      out += ch;
      i += 1;
      lastSignificantEnd = out.length;
      continue;
    }

    // Placeholder posicional `?` fora de strings, identificadores e comentarios
    if (ch === '?') {
      hasPositionalPlaceholder = true;
      paramIndex += 1;
      out += `$${paramIndex}`;
      i += 1;
      lastSignificantEnd = out.length;
      continue;
    }

    if (ch === ';' && parenDepth === 0) {
      trailingSemicolonIndex = out.length;
      out += ch;
      i += 1;
      continue;
    }

    if (isIdentifierStart(ch)) {
      const start = i;
      i += 1;
      while (i < sql.length && isIdentifierChar(sql[i])) i += 1;
      const word = sql.slice(start, i);
      const upper = word.toUpperCase();

      if (parenDepth === 0) {
        if (!firstKeyword) firstKeyword = upper;
        if (DML_KEYWORDS.has(upper)) topLevelDmlKeyword = upper;
        if (upper === 'RETURNING') hasTopLevelReturning = true;
      }

      out += word;
      lastSignificantEnd = out.length;
      continue;
    }

    out += ch;
    if (!/\s/.test(ch)) {
      lastSignificantEnd = out.length;
    }
    i += 1;
  }

  if (hasPositionalPlaceholder && hasNumberedPlaceholder) {
    throw new Error('Mistura nao suportada de placeholders ? e $n na mesma consulta SQL.');
  }

  const isInsert = firstKeyword === 'INSERT' || (firstKeyword === 'WITH' && topLevelDmlKeyword === 'INSERT');

  if (forRun && isInsert && !hasTopLevelReturning) {
    if (trailingSemicolonIndex !== -1 && trailingSemicolonIndex >= lastSignificantEnd) {
      out = out.slice(0, trailingSemicolonIndex) + ' RETURNING id' + out.slice(trailingSemicolonIndex);
    } else {
      out = out.slice(0, lastSignificantEnd) + ' RETURNING id' + out.slice(lastSignificantEnd);
    }
  }

  return {
    text: out,
    placeholderCount: paramIndex,
    isInsert,
    hasReturning: hasTopLevelReturning || (forRun && isInsert)
  };
}

function isUniqueConstraintError(err) {
  if (!err) return false;
  if (err.code === '23505') return true;
  return typeof err.message === 'string' && err.message.includes('UNIQUE');
}

function isForeignKeyError(err) {
  if (!err) return false;
  if (
    err.code === '23503' ||
    err.code === 'SQLITE_CONSTRAINT_FOREIGNKEY' ||
    err.code === 'SQLITE_CONSTRAINT_TRIGGER'
  ) {
    return true;
  }
  return typeof err.message === 'string' && (
    err.message.includes('FOREIGN KEY constraint failed') ||
    err.message.includes('CROSS_USER_DISCIPLINE')
  );
}

function isInvalidIntegerError(err) {
  return Boolean(err && err.code === '22P02');
}

module.exports = {
  translateSqlToPostgres,
  isUniqueConstraintError,
  isForeignKeyError,
  isInvalidIntegerError
};
