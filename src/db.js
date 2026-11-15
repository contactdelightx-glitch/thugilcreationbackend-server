require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: 10,
});

// an idle-client error must not crash the process
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

module.exports = pool;
