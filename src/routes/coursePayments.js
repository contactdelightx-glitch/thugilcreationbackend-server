const { Router } = require('express');
const pool = require('../db');
const { monthTrends } = require('../monthTrends');

const router = Router();
const STATUSES = ['pending', 'completed', 'failed', 'refunded'];

/**
 * @openapi
 * /api/course-payments/summary:
 *   get:
 *     tags: [Course payments]
 *     summary: Headline numbers for course payments (completed payments only)
 *     responses:
 *       200: { description: "{ payments, revenue, average, addOnRevenue, certificates, doubtSupport, discounts }" }
 */
router.get('/api/course-payments/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS payments,
              COALESCE(SUM(amount_paid), 0)::float AS revenue,
              COALESCE(ROUND(AVG(amount_paid), 2), 0)::float AS average,
              COALESCE(SUM(certificate_fee + doubt_support_fee), 0)::float AS "addOnRevenue",
              COUNT(*) FILTER (WHERE certificate_included)::int AS certificates,
              COUNT(*) FILTER (WHERE doubt_support_included)::int AS "doubtSupport",
              COALESCE(SUM(discount_amount), 0)::float AS discounts
         FROM enrollments WHERE payment_status = 'completed'`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/course-payments/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the summary' });
  }
});

/**
 * @openapi
 * /api/course-payments/trends:
 *   get:
 *     tags: [Course payments]
 *     summary: Month-so-far trend of course revenue, payments, average payment and add-on revenue, against the month before
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: "2026-11" }, description: Defaults to the current month }
 *     responses:
 *       200: { description: Series and totals per metric }
 *       400: { description: Invalid month }
 */
router.get('/api/course-payments/trends', async (req, res) => {
  try {
    const { status, body } = await monthTrends(pool, {
      month: req.query.month,
      metrics: ['revenue', 'payments', 'addons'],
      avg: { sum: 'revenue', count: 'payments' },
      rowsSql: `SELECT to_char(enrolled_at AT TIME ZONE $1, 'YYYY-MM') AS month,
                       EXTRACT(DAY FROM enrolled_at AT TIME ZONE $1)::int AS day,
                       COUNT(*)::int AS payments,
                       COALESCE(SUM(amount_paid), 0)::float AS revenue,
                       COALESCE(SUM(certificate_fee + doubt_support_fee), 0)::float AS addons
                  FROM enrollments
                 WHERE payment_status = 'completed'
                   AND (enrolled_at AT TIME ZONE $1) >= $2::date AND (enrolled_at AT TIME ZONE $1) < $3::date
                 GROUP BY 1, 2`,
      firstSql: `SELECT to_char(MIN(enrolled_at) AT TIME ZONE $1, 'YYYY-MM') AS m FROM enrollments WHERE payment_status = 'completed'`,
    });
    res.status(status).json(body);
  } catch (err) {
    console.error('GET /api/course-payments/trends failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

/**
 * @openapi
 * /api/course-payments:
 *   get:
 *     tags: [Course payments]
 *     summary: List course payments, newest first
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches payment number, student name, email, course, or the transaction / Razorpay ids }
 *       - { in: query, name: status, schema: { type: string, enum: [all, pending, completed, failed, refunded], default: all } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of payments, each with its price breakdown }
 */
router.get('/api/course-payments', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(e.id::text ILIKE ${p} OR COALESCE(u.full_name, e.student_name) ILIKE ${p} OR COALESCE(u.email, e.student_email) ILIKE ${p}
                 OR c.title ILIKE ${p} OR e.transaction_id ILIKE ${p} OR e.razorpay_order_id ILIKE ${p} OR e.razorpay_payment_id ILIKE ${p})`);
  }
  if (STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`e.payment_status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM enrollments e
                JOIN courses c ON c.id = e.course_id
                LEFT JOIN users u ON u.customer_id = e.customer_id`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT e.id, e.customer_id, COALESCE(u.full_name, e.student_name) AS student_name, COALESCE(u.email, e.student_email) AS student_email,
              c.title AS course_title, e.enrolled_at,
              e.base_price, e.discount_amount, e.certificate_included, e.certificate_fee, e.doubt_support_included, e.doubt_support_fee,
              e.amount_paid, e.currency, e.payment_status, e.payment_method,
              e.transaction_id, e.razorpay_order_id, e.razorpay_payment_id
         ${from} ${clause}
        ORDER BY e.enrolled_at DESC, e.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/course-payments failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch course payments' });
  }
});

module.exports = router;
