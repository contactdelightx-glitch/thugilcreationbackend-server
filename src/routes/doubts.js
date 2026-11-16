const { Router } = require('express');
const pool = require('../db');
const notify = require('../notify');

const router = Router();
const STATUSES = ['pending', 'answered'];
const MAX_ANSWER = 5000;

/**
 * @openapi
 * /api/doubts/summary:
 *   get:
 *     tags: [Doubts]
 *     summary: How many doubts are waiting, answered, and from how many students
 *     responses:
 *       200: { description: "{ total, pending, answered, students, oldestPending }" }
 */
router.get('/api/doubts/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'pending')::int AS pending,
              COUNT(*) FILTER (WHERE status = 'answered')::int AS answered,
              COUNT(DISTINCT LOWER(student_email))::int AS students,
              MIN(created_at) FILTER (WHERE status = 'pending') AS "oldestPending"
         FROM course_doubts`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/doubts/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the doubt summary' });
  }
});

/**
 * @openapi
 * /api/doubts:
 *   get:
 *     tags: [Doubts]
 *     summary: List doubts. Waiting ones come first, oldest first; answered ones follow, newest first
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [all, pending, answered], default: all } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches the question, answer, student, course or video }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of doubts, each saying whether the student bought doubt support }
 */
router.get('/api/doubts', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(d.question ILIKE ${p} OR d.answer ILIKE ${p} OR COALESCE(u.full_name, d.student_name) ILIKE ${p}
                 OR COALESCE(u.email, d.student_email) ILIKE ${p} OR c.title ILIKE ${p} OR v.title ILIKE ${p})`);
  }
  if (STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`d.status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM course_doubts d
                JOIN courses c ON c.id = d.course_id
                LEFT JOIN users u ON u.customer_id = d.customer_id
                LEFT JOIN course_videos v ON v.id = d.video_id
                LEFT JOIN course_sections s ON s.id = v.section_id`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT d.id, d.customer_id, COALESCE(u.full_name, d.student_name) AS student_name, COALESCE(u.email, d.student_email) AS student_email,
              d.course_id, c.title AS course_title, d.video_id, v.title AS video_title, s.title AS section_title,
              d.question, d.answer, d.status, d.created_at, d.answered_at,
              EXISTS (SELECT 1 FROM enrollments e WHERE e.customer_id = d.customer_id AND e.course_id = d.course_id
                         AND e.payment_status = 'completed' AND e.doubt_support_included) AS has_doubt_support
       ${from} ${clause}
       ORDER BY (d.status = 'answered'),
                CASE WHEN d.status = 'pending' THEN d.created_at END ASC,
                d.answered_at DESC NULLS LAST, d.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/doubts failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch doubts' });
  }
});

/**
 * @openapi
 * /api/doubts/{id}/answer:
 *   put:
 *     tags: [Doubts]
 *     summary: Answer a doubt (or change the answer). The doubt becomes "answered".
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [answer]
 *             properties:
 *               answer: { type: string, maxLength: 5000 }
 *     responses:
 *       200: { description: The updated doubt }
 *       400: { description: Empty or too long answer }
 *       404: { description: Doubt not found }
 */
router.put('/api/doubts/:id/answer', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid doubt id' });
  const answer = typeof (req.body && req.body.answer) === 'string' ? req.body.answer.trim() : '';
  if (!answer) return res.status(400).json({ error: 'Validation failed', fields: { answer: 'is required' } });
  if (answer.length > MAX_ANSWER) return res.status(400).json({ error: 'Validation failed', fields: { answer: `must be at most ${MAX_ANSWER} characters` } });
  try {
    const before = (await pool.query('SELECT answer FROM course_doubts WHERE id = $1', [id])).rows[0];
    const { rows } = await pool.query(
      `UPDATE course_doubts
          SET answer = $1, status = 'answered', answered_at = COALESCE(answered_at, NOW()), updated_at = NOW()
        WHERE id = $2
      RETURNING id, status, answer, answered_at, updated_at`,
      [answer, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Doubt not found' });
    if (!before || before.answer !== answer) notify.doubtAnswered(id); // tell the student; saving the same text again sends nothing
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/doubts/:id/answer failed:', err.message);
    res.status(500).json({ error: 'Failed to save the answer' });
  }
});

module.exports = router;
