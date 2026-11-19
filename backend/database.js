'use strict';

const { createDatabase } = require('./db');

module.exports = createDatabase(process.env);
