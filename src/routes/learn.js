const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const notify = require('../notify');
const s3 = require('../s3');
const { requireUser } = require('../auth');
const { razorpayKeys, razorpayCreateOrder } = require('../razorpay');
const { certificatePdf } = require('../certificatePdf');

const router = Router();

// ---------- the packages of a course ----------
// Basic is the course price. Standard adds the certificate (the course's own with-certificate price).
// Pro and Elite add doubt support / mentoring on top of Standard (these two amounts are a business rule kept here, in one place).
const PRO_EXTRA = 1000;
const ELITE_EXTRA = 3000;
const PACKAGE_NAMES = { basic: 'Basic', standard: 'Standard', pro: 'Pro', elite: 'Elite' };

function packagesOf(course) {
  const certFee = course.certificate_with_price > course.price ? Math.round((course.certificate_with_price - course.price) * 100) / 100 : null;
  const list = [{ key: 'basic', price: course.price, certificate_fee: 0, doubt_support_fee: 0 }];
  if (certFee !== null) {
    list.push(
      { key: 'standard', price: course.price + certFee, certificate_fee: certFee, doubt_support_fee: 0 },
      { key: 'pro', price: course.price + certFee + PRO_EXTRA, certificate_fee: certFee, doubt_support_fee: PRO_EXTRA },
      { key: 'elite', price: course.price + certFee + ELITE_EXTRA, certificate_fee: certFee, doubt_support_fee: ELITE_EXTRA },
    );
  }
  return list.map((p) => ({ ...p, name: PACKAGE_NAMES[p.key] }));
}

// which package an enrolment was bought as, read back from what was charged
function packageOfEnrollment(e) {
  if (!e.certificate_included) return 'Basic';
  if (!e.doubt_support_included) return 'Standard';
  return Number(e.doubt_support_fee) >= ELITE_EXTRA ? 'Elite' : 'Pro';
}

const loadCourse = async (id) => (await pool.query(
  `SELECT id, title, price::float AS price, certificate_with_price::float AS certificate_with_price, duration_months
     FROM courses WHERE id = $1 AND is_published`, [id])).rows[0];

// a current, paid enrolment of this shopper in this course (or none)
const activeEnrollment = async (customerId, courseId) => (await pool.query(
  `SELECT id, enrolled_at, expires_at, doubt_support_included, certificate_included FROM enrollments
    WHERE customer_id = $1 AND course_id = $2 AND payment_status = 'completed' AND is_active
      AND (expires_at IS NULL OR expires_at > NOW())
    ORDER BY enrolled_at DESC LIMIT 1`, [customerId, courseId])).rows[0];

/**
 * @openapi
 * /api/store/courses/{id}/checkout:
 *   post:
 *     tags: [Store]
 *     summary: Start paying for a course package (the price comes from the database, never from the browser)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [package], properties: { package: { type: string, enum: [basic, standard, pro, elite] } } }
 *     responses:
 *       200: { description: "{ orderId, amount (paise), currency, keyId, total, package }" }
 *       400: { description: Unknown package }
 *       401: { description: Not logged in }
 *       404: { description: Course not available }
 *       409: { description: Already enrolled }
 */
router.post('/api/store/courses/:id/checkout', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Course not found' });
  try {
    const course = await loadCourse(id);
    if (!course) return res.status(404).json({ error: 'This course is not available' });
    const pack = packagesOf(course).find((p) => p.key === req.body?.package);
    if (!pack) return res.status(400).json({ error: 'Please choose one of the packages' });
    if (pack.price < 1) return res.status(400).json({ error: 'This course has no price to pay' });
    if (await activeEnrollment(req.customerId, id)) return res.status(409).json({ error: 'You are already enrolled in this course.' });

    const amountPaise = Math.round(pack.price * 100);
    const order = await razorpayCreateOrder({ amountPaise, receipt: `k${req.customerId}-${id}-${Date.now()}` });
    await pool.query(
      'INSERT INTO checkout_sessions (razorpay_order_id, customer_id, amount, items) VALUES ($1, $2, $3, $4)',
      [order.id, req.customerId, pack.price, JSON.stringify({ kind: 'course', course_id: id, package: pack.key, base_price: course.price, certificate_fee: pack.certificate_fee, doubt_support_fee: pack.doubt_support_fee, duration_months: course.duration_months })]
    );
    res.json({ orderId: order.id, amount: amountPaise, currency: 'INR', keyId: razorpayKeys().id, total: pack.price, package: pack.name });
  } catch (err) {
    console.error('POST /api/store/courses/:id/checkout failed:', err.message);
    res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
  }
});

/**
 * @openapi
 * /api/store/courses/checkout/verify:
 *   post:
 *     tags: [Store]
 *     summary: Confirm a course payment (checks Razorpay's signature) and enrol the shopper
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [razorpay_order_id, razorpay_payment_id, razorpay_signature]
 *             properties: { razorpay_order_id: { type: string }, razorpay_payment_id: { type: string }, razorpay_signature: { type: string } }
 *     responses:
 *       200: { description: "{ enrollmentId, courseId }" }
 *       400: { description: Signature does not match }
 *       404: { description: No such payment for this shopper }
 */
router.post('/api/store/courses/checkout/verify', requireUser, async (req, res) => {
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'The payment details are incomplete' });

  let keys;
  try { keys = razorpayKeys(); } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Payments are not configured on the server' }); }
  const expected = Buffer.from(crypto.createHmac('sha256', keys.secret).update(`${orderId}|${paymentId}`).digest('hex'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return res.status(400).json({ error: 'The payment could not be verified. If money was taken, please contact us with your payment id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = await client.query('SELECT id, course_id FROM enrollments WHERE razorpay_payment_id = $1 AND customer_id = $2', [paymentId, req.customerId]);
    if (done.rows[0]) { await client.query('COMMIT'); return res.json({ enrollmentId: done.rows[0].id, courseId: done.rows[0].course_id, already: true }); }

    const found = await client.query('SELECT amount::float AS amount, items FROM checkout_sessions WHERE razorpay_order_id = $1 AND customer_id = $2 FOR UPDATE', [orderId, req.customerId]);
    const session = found.rows[0];
    if (!session || Array.isArray(session.items) || session.items.kind !== 'course') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No course payment is waiting for this account' }); }
    const it = session.items;

    const user = (await client.query('SELECT full_name, email FROM users WHERE customer_id = $1', [req.customerId])).rows[0] || {};
    const days = (it.duration_months > 0 ? it.duration_months : 6) * 30;
    const e = (await client.query(
      `INSERT INTO enrollments (customer_id, student_name, student_email, course_id, enrollment_type, payment_status, base_price,
                                certificate_included, certificate_fee, doubt_support_included, doubt_support_fee, amount_paid,
                                payment_method, razorpay_order_id, razorpay_payment_id, expires_at, access_duration_days)
       VALUES ($1,$2,$3,$4,'purchase','completed',$5,$6,$7,$8,$9,$10,'razorpay',$11,$12, NOW() + make_interval(days => $13::int), $13::int)
       RETURNING id`,
      [req.customerId, user.full_name || null, user.email || 'unknown', it.course_id, it.base_price,
       it.certificate_fee > 0, it.certificate_fee, it.doubt_support_fee > 0, it.doubt_support_fee, session.amount,
       orderId, paymentId, days]
    )).rows[0];
    await client.query('DELETE FROM checkout_sessions WHERE razorpay_order_id = $1', [orderId]);
    await client.query('COMMIT');
    notify.coursePurchased({ customerId: req.customerId, enrollmentId: e.id, courseId: it.course_id, packageKey: it.package, amount: session.amount, paymentId }); // not awaited: an email problem never fails the payment
    res.json({ enrollmentId: e.id, courseId: it.course_id });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/store/courses/checkout/verify failed:', err.message);
    res.status(500).json({ error: 'Your payment went through but we could not save your enrolment. Please contact us with your payment id.' });
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/store/courses/{id}/access:
 *   get:
 *     tags: [Store]
 *     summary: Is the logged-in shopper enrolled in this course right now?
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ enrolled, expires_at }" }
 *       401: { description: Not logged in }
 */
router.get('/api/store/courses/:id/access', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.json({ enrolled: false });
  try {
    const e = await activeEnrollment(req.customerId, id);
    res.json({ enrolled: Boolean(e), expires_at: e ? e.expires_at : null });
  } catch (err) {
    console.error('GET /api/store/courses/:id/access failed:', err.message);
    res.status(500).json({ error: 'Failed to check your access' });
  }
});

/**
 * @openapi
 * /api/store/enrollments/{id}:
 *   get:
 *     tags: [Store]
 *     summary: One of the logged-in shopper's own enrolments (for the enrolment-complete page)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ id, course_id, course_title, package, amount, enrolled_at, expires_at, payment_id }" }
 *       401: { description: Not logged in }
 *       404: { description: Not found, or not this shopper's }
 */
router.get('/api/store/enrollments/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Enrolment not found' });
  try {
    const e = (await pool.query(
      `SELECT e.id, e.course_id, c.title AS course_title, e.amount_paid::float AS amount, e.enrolled_at, e.expires_at,
              e.razorpay_payment_id AS payment_id, e.certificate_included, e.doubt_support_included, e.doubt_support_fee
         FROM enrollments e JOIN courses c ON c.id = e.course_id
        WHERE e.id = $1 AND e.customer_id = $2 AND e.payment_status = 'completed'`, [id, req.customerId])).rows[0];
    if (!e) return res.status(404).json({ error: 'Enrolment not found' });
    const { certificate_included, doubt_support_included, doubt_support_fee, ...rest } = e;
    res.json({ ...rest, package: packageOfEnrollment(e) });
  } catch (err) {
    console.error('GET /api/store/enrollments/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load your enrolment' });
  }
});

/**
 * @openapi
 * /api/store/learn:
 *   get:
 *     tags: [Store]
 *     summary: The courses the logged-in shopper can learn from now
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ data: [{ course_id, title, thumbnail_url, enrolled_at, expires_at }] }" }
 *       401: { description: Not logged in }
 */
router.get('/api/store/learn', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (e.course_id) e.course_id, c.title, c.thumbnail_url, e.enrolled_at, e.expires_at
         FROM enrollments e JOIN courses c ON c.id = e.course_id
        WHERE e.customer_id = $1 AND e.payment_status = 'completed' AND e.is_active AND (e.expires_at IS NULL OR e.expires_at > NOW())
        ORDER BY e.course_id, e.enrolled_at DESC`, [req.customerId]);
    res.json({ data: await Promise.all(rows.map(async (r) => ({ ...r, thumbnail_url: await s3.freshUrl(r.thumbnail_url) }))) });
  } catch (err) {
    console.error('GET /api/store/learn failed:', err.message);
    res.status(500).json({ error: 'Failed to load your courses' });
  }
});

// ---------- progress ----------
// A lesson counts as watched once the student has played 60% of it; only then does the next lesson open.
const WATCHED_AT = 0.6;
const CERTIFICATE_AT = 80; // % of the course that has to be finished before a certificate can be requested

/** the lessons of a course in the order they are taught, each with the student's progress and whether it is open yet */
async function lessonsFor(courseId, enrollmentId) {
  const [sections, videos] = await Promise.all([
    pool.query('SELECT id, title, description FROM course_sections WHERE course_id = $1 ORDER BY position, id', [courseId]),
    pool.query(
      `SELECT v.id, v.section_id, v.title, v.description, v.duration_seconds, v.video_url, v.thumbnail_url AS poster,
              p.max_position_seconds::float AS max_pos, p.position_seconds::float AS pos, p.duration_seconds::float AS pdur, p.is_completed
         FROM course_videos v
         JOIN course_sections s ON s.id = v.section_id
         LEFT JOIN enrollment_video_progress p ON p.video_id = v.id AND p.enrollment_id = $2
        WHERE s.course_id = $1 AND v.video_url IS NOT NULL AND v.video_url <> '' ORDER BY v.position, v.id`, [courseId, enrollmentId]),
  ]);
  const bySection = new Map(sections.rows.map((x) => [String(x.id), { title: x.title, description: x.description, videos: [] }]));
  for (const v of videos.rows) bySection.get(String(v.section_id))?.videos.push(v);
  const grouped = [...bySection.values()].filter((x) => x.videos.length);
  const flat = grouped.flatMap((x) => x.videos);
  const watched = (v) => { const d = v.duration_seconds || v.pdur || 0; return v.is_completed ? 100 : d ? Math.min(100, Math.round(((v.max_pos || 0) / d) * 100)) : 0; };
  const done = (v) => Boolean(v.is_completed) || watched(v) >= WATCHED_AT * 100;
  const firstOpen = flat.findIndex((v) => !done(v)); // every lesson up to and including this one is open
  const openUpTo = firstOpen === -1 ? flat.length - 1 : firstOpen;
  const index = new Map(flat.map((v, i) => [String(v.id), i]));
  const completed = flat.filter(done).length;
  return {
    flat, index, openUpTo, done, watched,
    progress: { completed, total: flat.length, percent: flat.length ? Math.round((completed / flat.length) * 100) : 0 },
    sections: grouped.map((x) => ({
      title: x.title, description: x.description,
      videos: x.videos.map((v) => {
        const open = index.get(String(v.id)) <= openUpTo;
        return { id: v.id, title: v.title, description: v.description, duration_seconds: v.duration_seconds || 0, locked: !open, done: done(v), watched_percent: watched(v), resume_seconds: open ? v.pos || 0 : 0, furthest_seconds: open ? v.max_pos || 0 : 0, url: open ? v.video_url : null, poster: open ? v.poster : null };
      }),
    })),
  };
}

/**
 * @openapi
 * /api/store/learn/{courseId}:
 *   get:
 *     tags: [Store]
 *     summary: The full course for a shopper enrolled in it, with progress. Lessons that are not open yet carry no video link
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ course, enrollment, progress: { completed, total, percent }, sections: [{ title, videos: [{ id, title, locked, done, watched_percent, resume_seconds, url, poster }] }] }" }
 *       401: { description: Not logged in }
 *       403: { description: Not enrolled (or the access has ended) }
 */
router.get('/api/store/learn/:courseId', requireUser, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) return res.status(404).json({ error: 'Course not found' });
  try {
    const enrollment = await activeEnrollment(req.customerId, courseId);
    if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this course, or your access has ended.' });
    const course = (await pool.query('SELECT id, title FROM courses WHERE id = $1', [courseId])).rows[0];
    if (!course) return res.status(404).json({ error: 'Course not found' });
    const l = await lessonsFor(courseId, enrollment.id);
    const mine = (await pool.query('SELECT rating, review_text FROM course_reviews WHERE course_id = $1 AND customer_id = $2', [courseId, req.customerId])).rows[0] || null;
    // the software this course uses, with its download link and install steps (links are for enrolled students only)
    const software = (await pool.query('SELECT id, name, description, platform, is_required, version, download_url, installation_instructions FROM course_software_links WHERE course_id = $1 ORDER BY position, id', [courseId])).rows;
    const cert = (await pool.query('SELECT status, certificate_number, full_name, title, delivery_email, requested_at, issued_at FROM certificates WHERE enrollment_id = $1', [enrollment.id])).rows[0] || null;
    await pool.query('UPDATE enrollments SET last_accessed_at = NOW() WHERE id = $1', [enrollment.id]);
    res.json({ course, enrollment: { expires_at: enrollment.expires_at }, progress: l.progress, watched_at: WATCHED_AT * 100, my_review: mine,
      software,
      certificate: enrollment.certificate_included ? { required: CERTIFICATE_AT, eligible: l.progress.percent >= CERTIFICATE_AT, ...(cert || { status: null }) } : null,
      doubt_support: Boolean(enrollment.doubt_support_included), sections: l.sections });
  } catch (err) {
    console.error('GET /api/store/learn/:courseId failed:', err.message);
    res.status(500).json({ error: 'Failed to load the course' });
  }
});

/**
 * @openapi
 * /api/store/learn/{courseId}/progress:
 *   post:
 *     tags: [Store]
 *     summary: Save how far the student has watched a lesson (a lesson is done at 60%)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [video_id, position_seconds], properties: { video_id: { type: integer }, position_seconds: { type: number }, duration_seconds: { type: number } } }
 *     responses:
 *       200: { description: "{ watched_percent, done, progress, next_unlocked }" }
 *       403: { description: Not enrolled, or that lesson is not open yet }
 */
router.post('/api/store/learn/:courseId/progress', requireUser, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const videoId = Number(req.body?.video_id);
  const position = Number(req.body?.position_seconds);
  if (!Number.isInteger(courseId) || !Number.isInteger(videoId) || !Number.isFinite(position) || position < 0) return res.status(400).json({ error: 'Invalid progress' });
  try {
    const enrollment = await activeEnrollment(req.customerId, courseId);
    if (!enrollment) return res.status(403).json({ error: 'You are not enrolled in this course, or your access has ended.' });
    const before = await lessonsFor(courseId, enrollment.id);
    const at = before.index.get(String(videoId));
    if (at === undefined) return res.status(404).json({ error: 'Lesson not found' });
    if (at > before.openUpTo) return res.status(403).json({ error: 'Finish the earlier lessons first.' });
    const v = before.flat[at];
    const duration = v.duration_seconds || Math.min(Math.max(Number(req.body?.duration_seconds) || 0, 0), 86400);
    if (!duration) return res.status(400).json({ error: 'The length of this lesson is not known' });
    // the furthest point can only move forward as fast as real playback allows (fast playback included): jumping ahead or posting a made-up position gains nothing
    const prev = (await pool.query('SELECT max_position_seconds::float AS m, last_played_at FROM enrollment_video_progress WHERE enrollment_id = $1 AND video_id = $2', [enrollment.id, videoId])).rows[0];
    const gap = prev && prev.last_played_at ? (Date.now() - new Date(prev.last_played_at).getTime()) / 1000 : 0;
    const allowedMax = prev ? prev.m + gap * 2.5 + 15 : 30;
    const pos = Math.min(position, duration);
    const furthest = Math.max(prev ? prev.m : 0, Math.min(pos, allowedMax));
    const completed = Boolean(v.is_completed) || furthest / duration >= WATCHED_AT;
    await pool.query(
      `INSERT INTO enrollment_video_progress (enrollment_id, video_id, duration_seconds, position_seconds, max_position_seconds, last_played_at, is_completed)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6)
       ON CONFLICT (enrollment_id, video_id) DO UPDATE
         SET duration_seconds = EXCLUDED.duration_seconds, position_seconds = EXCLUDED.position_seconds,
             max_position_seconds = GREATEST(enrollment_video_progress.max_position_seconds, EXCLUDED.max_position_seconds),
             last_played_at = NOW(), is_completed = enrollment_video_progress.is_completed OR EXCLUDED.is_completed`,
      [enrollment.id, videoId, duration, Math.min(pos, furthest + 1), furthest, completed]
    );
    const after = await lessonsFor(courseId, enrollment.id);
    // keep the figure the admin reads (students, certificates) up to date
    await pool.query(
      `UPDATE enrollments SET progress_percentage = GREATEST(progress_percentage, $2::int), last_accessed_at = NOW(),
              is_completed = is_completed OR $2::int = 100, completed_at = CASE WHEN completed_at IS NULL AND $2::int = 100 THEN NOW() ELSE completed_at END
        WHERE id = $1`, [enrollment.id, after.progress.percent]);
    res.json({ watched_percent: after.watched(after.flat[at]), done: after.done(after.flat[at]), progress: after.progress, next_unlocked: after.openUpTo > before.openUpTo });
  } catch (err) {
    console.error('POST /api/store/learn/:courseId/progress failed:', err.message);
    res.status(500).json({ error: 'Could not save your progress' });
  }
});

/**
 * @openapi
 * /api/store/learn/{courseId}/review:
 *   put:
 *     tags: [Store]
 *     summary: Write (or change) your review of a course you are enrolled in
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [rating], properties: { rating: { type: integer, minimum: 1, maximum: 5 }, review: { type: string, maxLength: 1000 } } }
 *     responses:
 *       200: { description: "{ rating, review_text }" }
 *       400: { description: Invalid rating or review }
 *       403: { description: Not enrolled }
 */
router.put('/api/store/learn/:courseId/review', requireUser, async (req, res) => {
  const courseId = Number(req.params.courseId);
  const rating = Number(req.body?.rating);
  const text = String(req.body?.review ?? '').trim();
  if (!Number.isInteger(courseId) || courseId < 1) return res.status(404).json({ error: 'Course not found' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars' });
  if (text.length > 1000) return res.status(400).json({ error: 'The review can be at most 1000 characters' });
  try {
    if (!(await activeEnrollment(req.customerId, courseId))) return res.status(403).json({ error: 'Only students of this course can review it.' });
    const user = (await pool.query('SELECT full_name FROM users WHERE customer_id = $1', [req.customerId])).rows[0] || {};
    const saved = (await pool.query(
      `INSERT INTO course_reviews (course_id, customer_id, reviewer_name, rating, review_text, is_published)
       VALUES ($1, $2, $3, $4, $5, TRUE)
       ON CONFLICT (course_id, customer_id) WHERE customer_id IS NOT NULL
       DO UPDATE SET rating = EXCLUDED.rating, review_text = EXCLUDED.review_text, reviewer_name = EXCLUDED.reviewer_name, updated_at = NOW()
       RETURNING rating, review_text`,
      [courseId, req.customerId, user.full_name || null, rating, text || null]
    )).rows[0];
    pool.query('SELECT title FROM courses WHERE id = $1', [courseId]).then((c) => notify.reviewPosted({ kind: 'course', reviewer: user.full_name, subject: c.rows[0]?.title || `course #${courseId}`, rating, text })).catch(() => {});
    res.json(saved);
  } catch (err) {
    console.error('PUT /api/store/learn/:courseId/review failed:', err.message);
    res.status(500).json({ error: 'Could not save your review. Please try again.' });
  }
});

// ---------- doubt support (packages with doubt support only) ----------
const MAX_OPEN_DOUBTS = 10; // unanswered questions one student can have in a course at a time

/**
 * @openapi
 * /api/store/learn/{courseId}/doubts:
 *   get:
 *     tags: [Store]
 *     summary: The logged-in student's own doubts in a course, newest first (packages with doubt support only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ data: [{ id, question, answer, status, lesson, created_at, answered_at }] }" }
 *       403: { description: Not enrolled, or the package has no doubt support }
 *   post:
 *     tags: [Store]
 *     summary: Ask a question about the course or one of its lessons (packages with doubt support only)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [question], properties: { question: { type: string, minLength: 5, maxLength: 1000 }, video_id: { type: integer } } }
 *     responses:
 *       201: { description: The new doubt, waiting for an answer }
 *       400: { description: Question too short or too long, or lesson not in this course }
 *       403: { description: Not enrolled, or the package has no doubt support }
 *       429: { description: Too many unanswered questions }
 */
async function doubtAccess(req, res) {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) { res.status(404).json({ error: 'Course not found' }); return null; }
  const e = await activeEnrollment(req.customerId, courseId);
  if (!e) { res.status(403).json({ error: 'You are not enrolled in this course, or your access has ended.' }); return null; }
  if (!e.doubt_support_included) { res.status(403).json({ error: 'Doubt support is not included in your package.' }); return null; }
  return { courseId, enrollment: e };
}

router.get('/api/store/learn/:courseId/doubts', requireUser, async (req, res) => {
  try {
    const a = await doubtAccess(req, res);
    if (!a) return;
    const { rows } = await pool.query(
      `SELECT d.id, d.question, d.answer, d.status, d.created_at, d.answered_at, v.title AS lesson
         FROM course_doubts d LEFT JOIN course_videos v ON v.id = d.video_id
        WHERE d.course_id = $1 AND d.customer_id = $2 ORDER BY d.created_at DESC, d.id DESC LIMIT 100`, [a.courseId, req.customerId]);
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/store/learn/:courseId/doubts failed:', err.message);
    res.status(500).json({ error: 'Failed to load your doubts' });
  }
});

router.post('/api/store/learn/:courseId/doubts', requireUser, async (req, res) => {
  const question = String(req.body?.question ?? '').trim();
  if (question.length < 5) return res.status(400).json({ error: 'Please write your question (at least 5 characters).' });
  if (question.length > 1000) return res.status(400).json({ error: 'The question can be at most 1000 characters.' });
  try {
    const a = await doubtAccess(req, res);
    if (!a) return;
    let videoId = null;
    if (req.body?.video_id !== undefined && req.body?.video_id !== null && req.body?.video_id !== '') {
      const v = (await pool.query(
        'SELECT v.id FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE v.id = $1 AND s.course_id = $2', [Number(req.body.video_id) || 0, a.courseId])).rows[0];
      if (!v) return res.status(400).json({ error: 'That lesson is not part of this course.' });
      videoId = v.id;
    }
    const open = (await pool.query("SELECT COUNT(*)::int AS n FROM course_doubts WHERE course_id = $1 AND customer_id = $2 AND status = 'pending'", [a.courseId, req.customerId])).rows[0].n;
    if (open >= MAX_OPEN_DOUBTS) return res.status(429).json({ error: `You have ${open} questions waiting for an answer. Please wait for replies before asking more.` });
    const user = (await pool.query('SELECT full_name, email FROM users WHERE customer_id = $1', [req.customerId])).rows[0] || {};
    const row = (await pool.query(
      `INSERT INTO course_doubts (customer_id, student_name, student_email, course_id, video_id, question)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, question, answer, status, created_at, answered_at`,
      [req.customerId, user.full_name || null, user.email || 'unknown', a.courseId, videoId, question])).rows[0];
    const lesson = videoId ? (await pool.query('SELECT title FROM course_videos WHERE id = $1', [videoId])).rows[0] : null;
    notify.doubtAsked({ doubtId: row.id, courseId: a.courseId, studentName: user.full_name, studentEmail: user.email || 'unknown', lesson: lesson ? lesson.title : null, question });
    res.status(201).json({ ...row, lesson: lesson ? lesson.title : null });
  } catch (err) {
    console.error('POST /api/store/learn/:courseId/doubts failed:', err.message);
    res.status(500).json({ error: 'Could not send your question. Please try again.' });
  }
});

// ---------- certificate (packages with a certificate only) ----------
const TITLES = ['Mr.', 'Ms.', 'Mrs.', 'Dr.'];
const LATIN_NAME = /^[A-Za-z\u00C0-\u00FF][A-Za-z\u00C0-\u00FF .'-]*$/; // the certificate is printed with standard fonts

/**
 * @openapi
 * /api/store/learn/{courseId}/certificate:
 *   post:
 *     tags: [Store]
 *     summary: Ask the instructor for the course certificate (needs a package with a certificate and 80% of the course finished)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [title, full_name, delivery_email], properties: { title: { type: string, enum: [Mr., Ms., Mrs., Dr.] }, full_name: { type: string }, delivery_email: { type: string } } }
 *     responses:
 *       201: { description: The request, waiting for the instructor }
 *       400: { description: Invalid details }
 *       403: { description: No certificate in the package, or less than 80% finished }
 *       409: { description: Already requested }
 */
router.post('/api/store/learn/:courseId/certificate', requireUser, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) return res.status(404).json({ error: 'Course not found' });
  const title = String(req.body?.title ?? '').trim();
  const name = String(req.body?.full_name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(req.body?.delivery_email ?? '').trim();
  const fields = {};
  if (!TITLES.includes(title)) fields.title = 'Choose Mr., Ms., Mrs. or Dr.';
  if (name.length < 2 || name.length > 80) fields.full_name = 'Write your full name (2 to 80 letters).';
  else if (!LATIN_NAME.test(name)) fields.full_name = 'Please write the name in English letters, exactly as it should be printed.';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 255) fields.delivery_email = 'Enter a valid email address.';
  if (Object.keys(fields).length) return res.status(400).json({ error: Object.values(fields)[0], fields });
  try {
    const e = await activeEnrollment(req.customerId, courseId);
    if (!e) return res.status(403).json({ error: 'You are not enrolled in this course, or your access has ended.' });
    if (!e.certificate_included) return res.status(403).json({ error: 'A certificate is not included in your package.' });
    const l = await lessonsFor(courseId, e.id);
    if (l.progress.percent < CERTIFICATE_AT) return res.status(403).json({ error: `Finish ${CERTIFICATE_AT}% of the course to request your certificate. You are at ${l.progress.percent}%.` });
    const made = await pool.query(
      `INSERT INTO certificates (enrollment_id, status, title, full_name, delivery_email, requested_at) VALUES ($1, 'requested', $2, $3, $4, NOW())
       ON CONFLICT (enrollment_id) DO NOTHING RETURNING status, title, full_name, delivery_email, requested_at`,
      [e.id, title, name, email]
    );
    if (!made.rows[0]) return res.status(409).json({ error: 'You have already requested your certificate.' });
    notify.certificateRequested(e.id);
    res.status(201).json(made.rows[0]);
  } catch (err) {
    console.error('POST /api/store/learn/:courseId/certificate failed:', err.message);
    res.status(500).json({ error: 'Could not send your request. Please try again.' });
  }
});

/**
 * @openapi
 * /api/store/certificates:
 *   get:
 *     tags: [Store]
 *     summary: Every certificate the logged-in student has earned (issued by the instructor), newest first
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ data: [{ course_id, course_title, certificate_number, full_name, title, issued_at }] }" }
 *       401: { description: Not logged in }
 */
router.get('/api/store/certificates', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT e.course_id, c.title AS course_title, cert.certificate_number, cert.full_name, cert.title, cert.issued_at
         FROM certificates cert JOIN enrollments e ON e.id = cert.enrollment_id JOIN courses c ON c.id = e.course_id
        WHERE e.customer_id = $1 AND e.payment_status = 'completed' AND cert.status = 'issued'
        ORDER BY cert.issued_at DESC`, [req.customerId]);
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/store/certificates failed:', err.message);
    res.status(500).json({ error: 'Failed to load your certificates' });
  }
});

/**
 * @openapi
 * /api/store/learn/{courseId}/certificate/download:
 *   get:
 *     tags: [Store]
 *     summary: Download your certificate (only after the instructor has approved it)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: courseId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The certificate as a PDF }
 *       403: { description: Not enrolled }
 *       404: { description: Not issued yet }
 */
router.get('/api/store/learn/:courseId/certificate/download', requireUser, async (req, res) => {
  const courseId = Number(req.params.courseId);
  if (!Number.isInteger(courseId) || courseId < 1) return res.status(404).json({ error: 'Course not found' });
  try {
    // a certificate that was issued stays downloadable even after the course access has ended
    const row = (await pool.query(
      `SELECT cert.certificate_number, cert.full_name, cert.title, cert.issued_at, cert.certificate_url, c.title AS course
         FROM certificates cert JOIN enrollments e ON e.id = cert.enrollment_id JOIN courses c ON c.id = e.course_id
        WHERE e.customer_id = $1 AND e.course_id = $2 AND e.payment_status = 'completed' AND cert.status = 'issued'
        ORDER BY cert.issued_at DESC LIMIT 1`, [req.customerId, courseId])).rows[0];
    if (!row) return res.status(404).json({ error: 'Your certificate has not been issued yet.' });
    const safe = String(row.certificate_number).replace(/[^A-Za-z0-9._-]+/g, '_');
    res.setHeader('Cache-Control', 'private, no-store');
    const send = (body, type, ext) => {
      res.setHeader('Content-Type', type);
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.${ext}"`);
      return res.send(body);
    };
    const extOf = (type) => ({ 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[String(type).split(';')[0]] || 'pdf');
    if (row.certificate_url && row.certificate_url.startsWith('s3://')) { // the file the instructor uploaded
      const f = await s3.getPrivate(row.certificate_url);
      return send(f.body, f.contentType, extOf(f.contentType));
    }
    if (row.certificate_url) { // a file from the old site
      const file = await fetch(await s3.freshUrl(row.certificate_url));
      if (file.ok) { const type = file.headers.get('content-type') || 'application/pdf'; return send(Buffer.from(await file.arrayBuffer()), type, extOf(type)); }
    }
    // issued without a file: a certificate drawn from the approved details
    return send(await certificatePdf({ title: row.title, name: row.full_name, course: row.course, number: row.certificate_number, issuedAt: row.issued_at }), 'application/pdf', 'pdf');
  } catch (err) {
    console.error('GET /api/store/learn/:courseId/certificate/download failed:', err.message);
    res.status(500).json({ error: 'Could not prepare your certificate. Please try again.' });
  }
});

module.exports = router;
module.exports.packagesOf = packagesOf;
