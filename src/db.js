const { Pool } = require('pg');
const config = require('./config');

const pool = new Pool({
  user: config.db.user,
  password: config.db.password,
  database: config.db.database,
  host: config.db.host,
  port: config.db.port,
});

async function query(text, params) {
  return pool.query(text, params);
}

module.exports = { pool, query };