const { Router } = require('express');
const pool = require('../db');

const router = Router();

/**
 * @openapi
 * /api/students/summary:
 *   get:
 *     tags: [Students]
 *     summary: Headline numbers for the Students page (students = people who have purchased a course)
 *     responses:
 *       200: { description: "{ students, enrollments, revenue, avgProgress, completed, certificatesIssued, certificatesIncluded }" }
 */
router.get('/api/students/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(DISTINCT customer_id)::int AS students,
              COUNT(*)::int AS enrollments,
              COALESCE(SUM(amount_paid), 0)::float AS revenue,
              COALESCE(ROUND(AVG(progress_percentage)), 0)::int AS "avgProgress",
              COUNT(*) FILTER (WHERE is_completed)::int AS completed,
              (SELECT COUNT(*) FROM certificates c JOIN enrollments e2 ON e2.id = c.enrollment_id
                WHERE c.status = 'issued' AND e2.payment_status = 'completed')::int AS "certificatesIssued",
              COUNT(*) FILTER (WHERE certificate_included)::int AS "certificatesIncluded"
         FROM enrollments WHERE payment_status = 'completed' AND customer_id IS NOT NULL`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/students/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the student summary' });
  }
});

/**
 * @openapi
 * /api/students:
 *   get:
 *     tags: [Students]
 *     summary: List students, meaning people who have purchased a course, with their latest enrollment
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, email, phone or course title }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of students, most recently enrolled first }
 */
router.get('/api/students', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(u.full_name ILIKE ${p} OR u.email ILIKE ${p} OR u.phone ILIKE ${p} OR le.course_title ILIKE ${p})`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // a student is someone with at least one completed (paid) enrollment; show their most recent one
  const from = `
    FROM users u
    JOIN LATERAL (
      SELECT e.id, c.title AS course_title, e.amount_paid, e.payment_status, e.enrolled_at, e.progress_percentage,
             e.is_completed, e.certificate_included, e.doubt_support_included, e.last_accessed_at, e.expires_at, e.is_active,
             (SELECT cert.status FROM certificates cert WHERE cert.enrollment_id = e.id) AS certificate_status
        FROM enrollments e JOIN courses c ON c.id = e.course_id
       WHERE e.customer_id = u.customer_id AND e.payment_status = 'completed'
       ORDER BY e.enrolled_at DESC LIMIT 1
    ) le ON TRUE`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT u.customer_id, u.full_name, u.email, u.phone, u.status AS account_status,
              (SELECT COUNT(*) FROM enrollments e2 WHERE e2.customer_id = u.customer_id AND e2.payment_status = 'completed')::int AS enrollment_count,
              le.id AS enrollment_id, le.course_title, le.amount_paid, le.payment_status, le.enrolled_at, le.progress_percentage,
              le.is_completed, le.certificate_included, le.doubt_support_included, le.last_accessed_at, le.expires_at, le.is_active,
              le.certificate_status
       ${from} ${clause}
       ORDER BY le.enrolled_at DESC, u.customer_id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/students failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch students' });
  }
});

/**
 * @openapi
 * /api/students/{id}/enrollments:
 *   get:
 *     tags: [Students]
 *     summary: A student's paid enrollments, with payment, certificate and video progress details
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer }, description: The student's customer id }
 *     responses:
 *       200: { description: Enrollments, newest first }
 *       404: { description: Student not found }
 */
router.get('/api/students/:id/enrollments', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid student id' });
  try {
    const student = await pool.query(
      `SELECT 1 FROM enrollments WHERE customer_id = $1 AND payment_status = 'completed' LIMIT 1`,
      [id]
    );
    if (!student.rowCount) return res.status(404).json({ error: 'Student not found' });
    const { rows } = await pool.query(
      `SELECT e.id, c.title AS course_title, e.enrollment_type, e.payment_status, e.base_price, e.discount_amount,
              e.certificate_included, e.certificate_fee, e.doubt_support_included, e.doubt_support_fee, e.amount_paid, e.currency,
              e.payment_method, e.transaction_id, e.razorpay_order_id, e.razorpay_payment_id,
              e.enrolled_at, e.expires_at, e.access_duration_days, e.last_accessed_at, e.is_active,
              e.progress_percentage, e.is_completed, e.completed_at,
              cert.status AS certificate_status, cert.certificate_number, cert.full_name AS certificate_name, cert.title AS certificate_title,
              cert.delivery_email AS certificate_email, cert.shipping_address AS certificate_address, cert.requested_at AS certificate_requested_at, cert.issued_at AS certificate_issued_at, cert.certificate_url,
              (SELECT COUNT(*) FROM enrollment_video_progress v WHERE v.enrollment_id = e.id)::int AS videos_started,
              (SELECT COUNT(*) FROM enrollment_video_progress v WHERE v.enrollment_id = e.id AND v.is_completed)::int AS videos_completed
         FROM enrollments e
         JOIN courses c ON c.id = e.course_id
         LEFT JOIN certificates cert ON cert.enrollment_id = e.id
        WHERE e.customer_id = $1 AND e.payment_status = 'completed'
        ORDER BY e.enrolled_at DESC`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/students/:id/enrollments failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch enrollments' });
  }
});

module.exports = router;
