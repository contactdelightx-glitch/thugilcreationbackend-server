const { Router } = require('express');
const pool = require('../db');

const router = Router();
const STATUSES = ['requested', 'issued', 'not_requested'];

// A certificate "exists" for a paid enrollment that bought one, or that already has a certificate record.
// Bought but never requested shows as "not_requested".
const FROM = `
  FROM enrollments e
  JOIN courses c ON c.id = e.course_id
  LEFT JOIN users u ON u.customer_id = e.customer_id
  LEFT JOIN certificates cert ON cert.enrollment_id = e.id
 WHERE e.payment_status = 'completed' AND (e.certificate_included OR cert.enrollment_id IS NOT NULL)`;
const STATUS_SQL = `COALESCE(cert.status, 'not_requested')`;

/**
 * @openapi
 * /api/certificates/summary:
 *   get:
 *     tags: [Certificates]
 *     summary: Certificate totals
 *     responses:
 *       200: { description: "{ total, issued, requested, notRequested, revenue }" }
 */
router.get('/api/certificates/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE ${STATUS_SQL} = 'issued')::int AS issued,
              COUNT(*) FILTER (WHERE ${STATUS_SQL} = 'requested')::int AS requested,
              COUNT(*) FILTER (WHERE ${STATUS_SQL} = 'not_requested')::int AS "notRequested",
              COALESCE(SUM(e.certificate_fee), 0)::float AS revenue
       ${FROM}`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/certificates/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the certificate summary' });
  }
});

/**
 * @openapi
 * /api/certificates:
 *   get:
 *     tags: [Certificates]
 *     summary: List certificates, requests first
 *     description: One row per paid enrollment that bought a certificate or has a certificate record.
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches certificate number, student, name on the certificate, or course }
 *       - { in: query, name: status, schema: { type: string, enum: [all, requested, issued, not_requested], default: all } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of certificates }
 */
router.get('/api/certificates', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const extra = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    extra.push(`(cert.certificate_number ILIKE ${p} OR COALESCE(u.full_name, e.student_name) ILIKE ${p} OR COALESCE(u.email, e.student_email) ILIKE ${p}
                 OR cert.full_name ILIKE ${p} OR c.title ILIKE ${p})`);
  }
  if (STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    extra.push(`${STATUS_SQL} = $${params.length}`);
  }
  const and = extra.length ? ` AND ${extra.join(' AND ')}` : '';

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${FROM}${and}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT e.id AS enrollment_id, e.customer_id,
              COALESCE(u.full_name, e.student_name) AS student_name, COALESCE(u.email, e.student_email) AS student_email,
              c.title AS course_title, e.enrolled_at, e.progress_percentage, e.certificate_fee::float AS certificate_fee,
              ${STATUS_SQL} AS status, cert.certificate_number, cert.title AS name_title, cert.full_name AS name_on_certificate,
              cert.delivery_email, cert.shipping_address, cert.requested_at, cert.issued_at, cert.certificate_url
       ${FROM}${and}
       ORDER BY CASE ${STATUS_SQL} WHEN 'requested' THEN 0 WHEN 'issued' THEN 1 ELSE 2 END,
                COALESCE(cert.issued_at, cert.requested_at, e.enrolled_at) DESC, e.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/certificates failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch certificates' });
  }
});

module.exports = router;
