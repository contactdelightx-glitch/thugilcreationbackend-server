/**
 * One-off import: Supabase public.customers + public.course_users -> local users table.
 *
 * Supabase is READ-ONLY here: only GET requests are made.
 * Safe to re-run: existing rows (same email or customer_id) are skipped.
 *
 *   node src/scripts/import-supabase.js            # dry run (nothing written)
 *   node src/scripts/import-supabase.js --commit   # write to the local DB
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');

async function fetchAll(table) {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=*&order=created_at.asc`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`${table}: ${JSON.stringify(body)}`);
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

const norm = (e) => String(e || '').trim().toLowerCase();
const clean = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());
const earlier = (a, b) => (new Date(a) <= new Date(b) ? a : b);

function build(customers, courseUsers) {
  const byEmail = new Map();
  const stats = { dupInCustomers: 0, merged: 0, hashDiffers: 0 };

  // customers first: they own the legacy customer_id (and win on password_hash)
  for (const c of customers) {
    const email = norm(c.email);
    if (byEmail.has(email)) { stats.dupInCustomers++; continue; } // keep earliest
    byEmail.set(email, {
      legacyId: c.customer_id,
      email,
      full_name: null,
      password_hash: c.password_hash,
      phone: clean(c.mobile_number),
      status: 'active',
      created_at: c.created_at,
    });
  }

  for (const u of courseUsers) {
    const email = norm(u.email);
    const fullName = clean(u.full_name);
    const existing = byEmail.get(email);
    if (existing) {
      stats.merged++;
      if (existing.password_hash !== u.password_hash) stats.hashDiffers++;
      existing.full_name = existing.full_name || fullName;
      existing.phone = existing.phone || clean(u.phone);
      existing.status = u.is_active === false ? 'suspended' : 'active';
      existing.created_at = earlier(existing.created_at, u.created_at);
    } else {
      byEmail.set(email, {
        legacyId: null,
        email,
        full_name: fullName,
        password_hash: u.password_hash,
        phone: clean(u.phone),
        status: u.is_active === false ? 'suspended' : 'active',
        created_at: u.created_at,
      });
    }
  }
  return { users: [...byEmail.values()], stats };
}

(async () => {
  const [customers, courseUsers] = await Promise.all([fetchAll('customers'), fetchAll('course_users')]);
  const { users, stats } = build(customers, courseUsers);

  console.log({
    source: { customers: customers.length, course_users: courseUsers.length },
    ...stats,
    toImport: users.length,
    withLegacyCustomerId: users.filter((u) => u.legacyId != null).length,
    mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (!COMMIT) return;

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    const bumpSequence = () => client.query(`
      SELECT setval(pg_get_serial_sequence('users', 'customer_id'),
                    GREATEST((SELECT COALESCE(MAX(customer_id), 0) FROM users), 1))`);
    // users with a legacy id first, then move the counter past them, then the rest
    users.sort((x, y) => (y.legacyId != null) - (x.legacyId != null));
    let bumped = false;
    for (const u of users) {
      if (u.legacyId == null && !bumped) { await bumpSequence(); bumped = true; }
      const cols = ['full_name', 'email', 'password_hash', 'phone', 'status', 'created_at'];
      const vals = [u.full_name, u.email, u.password_hash, u.phone, u.status, u.created_at];
      if (u.legacyId != null) { cols.push('customer_id'); vals.push(u.legacyId); }
      const r = await client.query(
        `INSERT INTO users (${cols.join(',')}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(',')})
         ON CONFLICT DO NOTHING`,
        vals
      );
      inserted += r.rowCount;
    }
    // keep generated ids (for new users) above any imported legacy id
    await bumpSequence();
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query('SELECT COUNT(*)::int AS total FROM users');
  console.log({ inserted, skippedAlreadyPresent: users.length - inserted, usersTableTotal: rows[0].total });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
