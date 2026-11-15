/**
 * One-off import of the course side of Supabase into the local database:
 *   course_categories, course_courses, course_users, course_users_enrollment, course_certificates (file links)
 * ->  course_categories, courses, enrollments, certificates, enrollment_video_progress
 *
 * Supabase is READ-ONLY here: only GET requests are made. Passwords are never read.
 * Safe to re-run: rows that already exist are skipped (and so are the child rows of enrollments already there).
 *
 *   node src/scripts/import-courses.js            # dry run (nothing written)
 *   node src/scripts/import-courses.js --commit   # write to the local DB
 *
 * Mapping notes
 *  - a student is matched to an account in `users` by email
 *  - doubt_support_fee is worked out as what was paid beyond base - discount + certificate
 *  - certificate columns move to certificates (only when a certificate was requested or issued)
 *  - video_progress (json) + completed_videos (array) become one row per video
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');
const round2 = (n) => Math.round(Number(n) * 100) / 100;
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

function build({ categories, courses, courseUsers, enrollments }, accounts) {
  const rejected = [];
  const stats = { studentsWithoutAccount: 0, doubtFeeDerived: 0, certificateRows: 0, videoRows: 0, completedVideoOnly: 0 };

  const cats = categories.map((c) => ({ id: c.category_id, name: text(c.name), description: text(c.description), created_at: c.created_at }));

  const courseRows = courses.map((c) => ({
    id: c.course_id, title: c.title, description: text(c.description), instructor_name: c.instructor_name,
    price: round2(c.price),
    certificate_with_price: c.certificate_with_price == null ? null : round2(c.certificate_with_price),
    certificate_without_price: c.certificate_without_price == null ? null : round2(c.certificate_without_price),
    is_published: c.is_published === true,
    status: ['draft', 'published', 'archived'].includes(c.status) ? c.status : c.is_published ? 'published' : 'draft',
    category_id: c.category_id ?? null, thumbnail_url: text(c.thumbnail_url), language: text(c.language),
    duration: text(c.duration), duration_months: c.duration_months ?? null, created_at: c.created_at, updated_at: c.updated_at || c.created_at,
  }));

  // a student is an existing account in `users`, found by email; nothing extra is stored for them
  const studentByLegacy = new Map();
  for (const u of courseUsers) {
    const email = String(u.email || '').trim().toLowerCase();
    const customerId = accounts.get(email);
    if (!customerId) { stats.studentsWithoutAccount++; rejected.push({ table: 'course_users', id: u.user_id, reason: 'no matching account by email' }); continue; }
    studentByLegacy.set(u.user_id, { customerId, email, name: text(u.full_name) });
  }

  const enr = [];
  for (const e of enrollments) {
    const fail = (reason) => rejected.push({ table: 'enrollment', id: e.enrollment_id, reason });
    const student = studentByLegacy.get(e.user_id);
    if (!student) { fail('student has no account'); continue; }

    const base = round2(e.base_course_price);
    const discount = round2(e.discount_amount || 0);
    const certFee = round2(e.certificate_fee || 0);
    const paid = round2(e.amount_paid);
    const doubtFee = round2(paid - (base - discount + certFee));
    if (doubtFee < 0) { fail(`paid ${paid} is less than ${base} - ${discount} + ${certFee}`); continue; }
    if (doubtFee > 0 && e.doubt_support_included !== true) { fail(`unexplained extra payment of ${doubtFee}`); continue; }
    if (doubtFee > 0) stats.doubtFeeDerived++;

    const certStatus = text(e.certificate_status) || 'not_requested';
    if ((certStatus === 'issued') !== (e.certificate_issued === true)) { fail('certificate_issued disagrees with certificate_status'); continue; }

    const row = {
      id: e.enrollment_id, customer_id: student.customerId, student_name: student.name, student_email: student.email,
      course_id: e.course_id, enrollment_type: text(e.enrollment_type) || 'purchase', payment_status: String(e.payment_status || '').trim().toLowerCase(),
      base_price: base, discount_percentage: round2(e.discount_percentage || 0), discount_amount: discount,
      certificate_included: e.certificate_included === true, certificate_fee: certFee,
      doubt_support_included: e.doubt_support_included === true, doubt_support_fee: doubtFee,
      amount_paid: paid, currency: e.currency || 'INR',
      payment_method: text(e.payment_method), transaction_id: text(e.transaction_id), razorpay_order_id: text(e.razorpay_order_id), razorpay_payment_id: text(e.razorpay_payment_id),
      enrolled_at: e.enrolled_at, expires_at: e.expires_at || null, access_duration_days: e.access_duration_days ?? null,
      last_accessed_at: e.last_accessed_at || null, is_active: e.is_active !== false,
      progress_percentage: Math.min(Math.max(Number(e.progress_percentage) || 0, 0), 100), is_completed: e.is_completed === true, completed_at: e.completed_at || null,
      purchase_count: e.purchase_count || 1, previous_enrollment_id: e.previous_enrollment_id ?? null,
      created_at: e.created_at, updated_at: e.updated_at || e.created_at,
    };

    let certificate = null;
    if (certStatus !== 'not_requested') {
      certificate = {
        status: certStatus === 'issued' ? 'issued' : 'requested', certificate_number: text(e.certificate_number),
        full_name: text(e.certificate_full_name), title: text(e.certificate_title), delivery_email: text(e.certificate_delivery_email)?.toLowerCase() ?? null,
        shipping_address: text(e.certificate_shipping_address), requested_at: e.certificate_requested_at || null, issued_at: e.certificate_issued_at || null,
      };
      stats.certificateRows++;
    }

    const videos = new Map();
    for (const [key, p] of Object.entries(e.video_progress || {})) {
      const id = Number(key);
      if (!Number.isInteger(id)) continue;
      videos.set(id, { video_id: id, duration_seconds: p.duration ?? null, position_seconds: p.timestamp ?? null, max_position_seconds: p.maxTimestamp ?? null, last_played_at: p.lastPlayed || null, is_completed: false });
    }
    for (const key of e.completed_videos || []) {
      const id = Number(key);
      if (!Number.isInteger(id)) continue;
      if (videos.has(id)) videos.get(id).is_completed = true;
      else { videos.set(id, { video_id: id, duration_seconds: null, position_seconds: null, max_position_seconds: null, last_played_at: null, is_completed: true }); stats.completedVideoOnly++; }
    }
    stats.videoRows += videos.size;

    enr.push({ row, certificate, videos: [...videos.values()] });
  }
  return { cats, courseRows, enr, rejected, stats };
}

async function insert(client, table, row) {
  const cols = Object.keys(row);
  const r = await client.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
    cols.map((c) => row[c])
  );
  return r.rowCount;
}

(async () => {
  const [categories, courses, courseUsers, enrollments, certificateFiles] = await Promise.all([
    fetchAll('course_categories'), fetchAll('course_courses'),
    fetchAll('course_users', 'user_id,full_name,email,profile_image_url,bio,phone,is_active,email_verified,created_at,updated_at,last_login_at'),
    fetchAll('course_users_enrollment'), fetchAll('course_certificates'),
  ]);
  const accounts = new Map((await pool.query('SELECT customer_id, LOWER(email) AS email FROM users')).rows.map((u) => [u.email, u.customer_id]));
  const { cats, courseRows, enr, rejected, stats } = build({ categories, courses, courseUsers, enrollments }, accounts);

  console.log({
    source: { categories: categories.length, courses: courses.length, students: courseUsers.length, enrollments: enrollments.length },
    toImport: { categories: cats.length, courses: courseRows.length, enrollments: enr.length },
    certificateFilesToLink: certificateFiles.filter((c) => c.certificate_url && c.enrollment_id).length,
    ...stats, rejected: rejected.length, mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (rejected.length) console.log('rejected:', rejected);
  if (!COMMIT) return;

  const client = await pool.connect();
  const done = { categories: 0, courses: 0, enrollments: 0, certificates: 0, videos: 0, certificateFilesLinked: 0 };
  try {
    await client.query('BEGIN');
    for (const c of cats) done.categories += await insert(client, 'course_categories', c);
    for (const c of courseRows) done.courses += await insert(client, 'courses', c);
    // previous_enrollment_id points at another enrollment, so insert the referenced ones first
    const ordered = [...enr].sort((a, b) => a.row.id - b.row.id);
    for (const e of ordered) {
      const { previous_enrollment_id: prev, ...rest } = e.row;
      if (!(await insert(client, 'enrollments', rest))) continue; // already there: its child rows are too
      done.enrollments++;
      if (prev) await client.query('UPDATE enrollments SET previous_enrollment_id = $1 WHERE id = $2', [prev, e.row.id]);
      if (e.certificate) done.certificates += await insert(client, 'certificates', { enrollment_id: e.row.id, ...e.certificate });
      for (const v of e.videos) done.videos += await insert(client, 'enrollment_video_progress', { enrollment_id: e.row.id, ...v });
    }
    // certificate file links go onto the certificate rows (only where one is still missing)
    for (const c of certificateFiles) {
      if (!c.certificate_url || !c.enrollment_id) continue;
      const r = await client.query(
        'UPDATE certificates SET certificate_url = $1 WHERE enrollment_id = $2 AND certificate_url IS NULL',
        [c.certificate_url, c.enrollment_id]
      );
      done.certificateFilesLinked += r.rowCount;
    }
    for (const [table, col] of [['course_categories', 'id'], ['courses', 'id'], ['enrollments', 'id']]) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${table}', '${col}'), GREATEST((SELECT COALESCE(MAX(${col}), 0) FROM ${table}), 1))`);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log({ inserted: done });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
