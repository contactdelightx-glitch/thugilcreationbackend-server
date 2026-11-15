/**
 * One-off import: Supabase public.sareerating -> local saree_ratings.
 *
 * Supabase is READ-ONLY here: only GET requests are made. Safe to re-run: rows whose id exists are skipped.
 *
 *   node src/scripts/import-saree-ratings.js            # dry run (nothing written)
 *   node src/scripts/import-saree-ratings.js --commit   # write to the local DB
 *
 * A rating's design_id is matched to the design tables so the category is known; ratings with no design
 * stay general ratings of the site.
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');
const CATEGORIES = ['butta', 'brocade', 'border', 'pallu', 'pattern', 'full_set', 'free_image'];

async function fetchAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/sareerating?select=*&order=id.asc`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(JSON.stringify(body));
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

(async () => {
  const source = await fetchAll();
  const designs = new Map();
  for (const c of CATEGORIES) {
    for (const r of (await pool.query(`SELECT id FROM ${c}_designs`)).rows) designs.set(String(r.id), [...(designs.get(String(r.id)) || []), c]);
  }

  const rows = [];
  const rejected = [];
  const stats = { general: 0, forDesign: 0, designNotFound: 0, designAmbiguous: 0, withReview: 0, reviewsTrimmed: 0 };
  for (const r of source) {
    if (!Number.isInteger(r.rating) || r.rating < 1 || r.rating > 5) { rejected.push({ id: r.id, reason: `rating ${r.rating} is not 1-5` }); continue; }
    const review = r.review == null ? null : String(r.review).trim() || null;
    if (r.review != null && review !== r.review) stats.reviewsTrimmed++;
    if (review) stats.withReview++;

    let category = null;
    if (r.design_id == null) stats.general++;
    else {
      const found = designs.get(String(r.design_id)) || [];
      if (found.length === 1) { category = found[0]; stats.forDesign++; }
      else if (found.length === 0) stats.designNotFound++;
      else stats.designAmbiguous++;
    }
    rows.push({ id: r.id, design_id: r.design_id ?? null, design_category: category, rating: r.rating, review, created_at: r.created_at });
  }

  console.log({ source: source.length, toImport: rows.length, ...stats, rejected: rejected.length, mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)' });
  if (rejected.length) console.log('rejected:', rejected);
  if (!COMMIT) return;

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const cols = Object.keys(row);
      const r = await client.query(
        `INSERT INTO saree_ratings (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c])
      );
      inserted += r.rowCount;
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('saree_ratings', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM saree_ratings), 1))`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows: t } = await pool.query('SELECT COUNT(*)::int AS total FROM saree_ratings');
  console.log({ inserted, skippedAlreadyPresent: rows.length - inserted, tableTotal: t[0].total });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
