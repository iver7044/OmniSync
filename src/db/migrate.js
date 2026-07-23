/**
 * db/migrate.js
 * Applies schema.sql to the configured database.
 * Run with: npm run migrate
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const pool = require('./pool');

async function migrate() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf-8');
  console.log('[migrate] Applying schema.sql...');
  await pool.query(sql);
  console.log('[migrate] Done ✓');
  await pool.end();
}

migrate().catch((err) => {
  console.error('[migrate] Failed:', err);
  process.exit(1);
});
