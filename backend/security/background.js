'use strict';

let vercelWaitUntil = null;
try {
  ({ waitUntil: vercelWaitUntil } = require('@vercel/functions'));
} catch {
  vercelWaitUntil = null;
}

/**
 * Registra tarefas assincronas de manutencao via waitUntil do @vercel/functions
 * no runtime Fluid Compute/Serverless, evitando suspensao antes da conclusao.
 * Fora da Vercel, executa como promessa protegida sem propagar rejeicoes.
 */
function scheduleBackgroundTask(taskPromise) {
  if (!taskPromise || typeof taskPromise.then !== 'function') {
    return;
  }
  const guarded = Promise.resolve(taskPromise).catch(() => {});
  if (typeof vercelWaitUntil === 'function') {
    try {
      vercelWaitUntil(guarded);
    } catch {
      // Fora de um Request Context ativo na Vercel, a promessa segue protegida.
    }
  }
  return guarded;
}

module.exports = {
  scheduleBackgroundTask
};
