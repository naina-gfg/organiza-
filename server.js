'use strict';

// Referencia explicita para deteccao oficial do framework Express na Vercel (@vercel/express)
require('express');
const app = require('./backend/server');

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Servidor iniciado em http://localhost:${PORT}`);
  });
}

module.exports = app;
