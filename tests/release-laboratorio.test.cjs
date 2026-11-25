'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildPublic } = require('../scripts/build-public.cjs');

const root = path.resolve(__dirname, '..');

test('artefato oficial não inclui laboratório mesmo com arquivos didáticos presentes', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'organiza-release-assets-'));
  try {
    fs.cpSync(path.join(root, 'frontend'), path.join(temp, 'frontend'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'frontend', 'academico'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'frontend', 'academico', 'catalogo.json'), '{"segredo":"marcador"}');
    fs.mkdirSync(path.join(temp, 'academico'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'academico', 'painel.js'), 'marcador');
    const result = buildPublic({ rootDir: temp });
    assert.equal(result.files.some(file => /academico|visualizador|catalogo/i.test(file)), false);
    assert.equal(fs.existsSync(path.join(result.outputDir, 'academico')), false);
    assert.equal(fs.readFileSync(path.join(temp, 'academico', 'painel.js'), 'utf8'), 'marcador');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('runtime e empacotamento excluem módulos do laboratório', () => {
  const runtime = fs.readFileSync(path.join(root, 'backend', 'server.js'), 'utf8');
  const ignore = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8');
  const config = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  assert.doesNotMatch(runtime, /require\s*\([^\n]*academico/i);
  assert.match(ignore, /^academico\/$/m);
  assert.ok(config.functions['server.js'].excludeFiles.includes('academico/**'));
  assert.equal(JSON.stringify(config).includes('includeFiles'), false);
});
