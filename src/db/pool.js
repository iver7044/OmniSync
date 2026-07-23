/**
 * db/pool.js
 * Single shared Postgres connection pool. All token/config storage goes
 * through here instead of local JSON files, so it works identically
 * regardless of which machine the app is running on.
 */
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_SSL === 'false' ? false : { rejectUnauthorized: false },
});

pool.on('error', (err) => {
  console.error('[db] Unexpected error on idle client', err);
});

module.exports = pool;
