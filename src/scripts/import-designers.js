/**
 * One-off import: Supabase public.users -> local designers table.
 *
 * Supabase is READ-ONLY here: only GET requests are made, and passwords are never read into the
 * local database. Safe to re-run: designers whose email already exists are skipped.
 *
 *   node src/scripts/import-designers.js            # dry run (nothing written)
 *   node src/scripts/import-designers.js --commit   # write to the local DB
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');

async function fetchAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/users?select=id,email,type,status,created_at&order=id.asc`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(JSON.stringify(body));
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

const timestamp = (v) => (/(Z|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`); // source has no tz -> treat as UTC

(async () => {
  const source = await fetchAll();
  const seen = new Set();
  const designers = [];
  const rejected = [];
  for (const u of source) {
    const email = String(u.email || '').trim().toLowerCase();
    if (!email) { rejected.push({ id: u.id, reason: 'missing email' }); continue; }
    if (seen.has(email)) { rejected.push({ id: u.id, reason: 'duplicate email' }); continue; }
    if (!['tenant', 'superadmin'].includes(u.type)) { rejected.push({ id: u.id, reason: `unknown type "${u.type}"` }); continue; }
    seen.add(email);
    designers.push({ id: u.id, email, type: u.type, status: u.status || 'active', created_at: timestamp(u.created_at) });
  }

  console.log({
    source: source.length,
    toImport: designers.length,
    byType: designers.reduce((m, d) => ({ ...m, [d.type]: (m[d.type] || 0) + 1 }), {}),
    rejected: rejected.length,
    mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (rejected.length) console.log('rejected:', rejected);
  if (!COMMIT) return;

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const d of designers) {
      const r = await client.query(
        `INSERT INTO designers (id, email, type, status, created_at) VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`,
        [d.id, d.email, d.type, d.status, d.created_at]
      );
      inserted += r.rowCount;
    }
    await client.query(
      `SELECT setval(pg_get_serial_sequence('designers', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM designers), 1))`
    );
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM designers');
  console.log({ inserted, skippedAlreadyPresent: designers.length - inserted, designersTableTotal: rows[0].total });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
