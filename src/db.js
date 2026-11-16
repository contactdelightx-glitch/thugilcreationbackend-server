require('dotenv').config();
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 5000,
  max: Number(process.env.DB_POOL_MAX) || 5, // the database role only allows a limited number of connections
});

// an idle-client error must not crash the process
pool.on('error', (err) => console.error('Postgres pool error:', err.message));

module.exports = pool;
