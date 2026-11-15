/**
 * Import of student doubts: Supabase public.course_doubts -> local course_doubts.
 *
 * Supabase is READ-ONLY here: only GET requests are made. Safe to re-run: doubts whose id exists are skipped
 * (an answer already written here is never overwritten).
 *
 *   node src/scripts/import-doubts.js            # dry run (nothing written)
 *   node src/scripts/import-doubts.js --commit   # write to the local DB
 *
 * A doubt with a non-empty answer comes in as "answered", anything else as "pending".
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

async function fetchAll(table, select = '*') {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=${select}`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`${table}: ${JSON.stringify(body)}`);
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

(async () => {
  const [doubts, students] = await Promise.all([fetchAll('course_doubts'), fetchAll('course_users', 'user_id,full_name,email')]);
  const courses = new Set((await pool.query('SELECT id FROM courses')).rows.map((r) => String(r.id)));
  const videos = new Set((await pool.query('SELECT id FROM course_videos')).rows.map((r) => String(r.id)));
  const accounts = new Map((await pool.query('SELECT customer_id, LOWER(email) AS email FROM users')).rows.map((u) => [u.email, u.customer_id]));
  const studentById = new Map(students.map((s) => [s.user_id, s]));

  const rows = [];
  const rejected = [];
  const stats = { answered: 0, pending: 0, videoMissing: 0, noAccount: 0 };
  for (const d of doubts) {
    const s = studentById.get(d.user_id);
    if (!s) { rejected.push({ id: d.doubt_id, reason: `student ${d.user_id} not found` }); continue; }
    if (!courses.has(String(d.course_id))) { rejected.push({ id: d.doubt_id, reason: `course ${d.course_id} not imported` }); continue; }
    const question = text(d.question);
    if (!question) { rejected.push({ id: d.doubt_id, reason: 'empty question' }); continue; }
    const email = String(s.email || '').trim().toLowerCase();
    const customerId = accounts.get(email) ?? null;
    if (!customerId) stats.noAccount++;
    const videoOk = d.video_id != null && videos.has(String(d.video_id));
    if (d.video_id != null && !videoOk) stats.videoMissing++;
    const answer = text(d.answer);
    answer ? stats.answered++ : stats.pending++;
    rows.push({
      id: d.doubt_id, customer_id: customerId, student_name: text(s.full_name), student_email: email, course_id: d.course_id,
      video_id: videoOk ? d.video_id : null, question, answer, status: answer ? 'answered' : 'pending',
      answered_at: answer ? d.updated_at || d.created_at : null, created_at: d.created_at, updated_at: d.updated_at || d.created_at,
    });
  }

  console.log({ source: doubts.length, toImport: rows.length, ...stats, rejected: rejected.length, mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)' });
  if (rejected.length) console.log('rejected:', rejected);
  if (!COMMIT) return;

  const client = await pool.connect();
  let inserted = 0;
  try {
    await client.query('BEGIN');
    for (const row of rows) {
      const cols = Object.keys(row);
      const r = await client.query(
        `INSERT INTO course_doubts (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c])
      );
      inserted += r.rowCount;
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('course_doubts', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM course_doubts), 1))`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows: t } = await pool.query('SELECT COUNT(*)::int AS total FROM course_doubts');
  console.log({ inserted, skippedAlreadyPresent: rows.length - inserted, tableTotal: t[0].total });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
