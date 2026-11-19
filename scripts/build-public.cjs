'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SOURCE_DIR = path.join(ROOT, 'frontend');
const OUTPUT_DIR = path.join(ROOT, 'public');

const ALLOWED_ASSETS = [
  'index.html',
  'cadastro.html',
  'dashboard.html',
  'disciplinas.html',
  'tarefas.html',
  path.join('css', 'style.css'),
  path.join('js', 'api.js'),
  path.join('js', 'auth.js'),
  path.join('js', 'dashboard.js'),
  path.join('js', 'disciplinas.js'),
  path.join('js', 'tarefas.js'),
  path.join('js', 'task-utils.js')
];

function buildPublic({ rootDir = ROOT } = {}) {
  const sourceDir = path.join(rootDir, 'frontend');
  const outputDir = path.join(rootDir, 'public');

  if (!fs.existsSync(sourceDir)) {
    throw new Error(`Diretorio canonico frontend/ nao encontrado em ${sourceDir}`);
  }

  fs.rmSync(outputDir, { recursive: true, force: true });
  fs.mkdirSync(outputDir, { recursive: true });

  const publishedFiles = [];
  for (const relPath of ALLOWED_ASSETS) {
    const src = path.join(sourceDir, relPath);
    const dest = path.join(outputDir, relPath);

    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      throw new Error(`Ativo obrigatorio ausente em frontend/: ${relPath}`);
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    publishedFiles.push(relPath.replace(/\\/g, '/'));
  }

  return {
    outputDir,
    files: publishedFiles
  };
}

if (require.main === module) {
  const result = buildPublic();
  console.log(`Build estatico concluido em ${result.outputDir} (${result.files.length} arquivos).`);
}

module.exports = {
  ALLOWED_ASSETS,
  buildPublic
};
