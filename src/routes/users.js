const { Router } = require('express');
const pool = require('../db');

const router = Router();

const STATUSES = ['active', 'suspended', 'removed'];

/**
 * @openapi
 * /api/users:
 *   get:
 *     tags: [Users]
 *     summary: List users (admin view, paginated)
 *     parameters:
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position; overrides page (used for infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 10, maximum: 100 } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches full name, email, phone or customer id }
 *       - { in: query, name: status, schema: { type: string, enum: [all, active, suspended, removed], default: all } }
 *     responses:
 *       200:
 *         description: A page of users. Password hashes are never returned.
 */
router.get('/api/users', async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 100);
  const search = String(req.query.search || '').trim();
  const offset = req.query.offset !== undefined ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : (page - 1) * limit;
  const status = req.query.status;

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(
      `(full_name ILIKE $${params.length} OR email ILIKE $${params.length}
        OR phone ILIKE $${params.length} OR customer_id::text ILIKE $${params.length})`
    );
  }
  if (STATUSES.includes(status)) {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM users ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT customer_id, full_name, email, phone, status, created_at
         FROM users ${clause}
        ORDER BY customer_id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, page, limit, offset, total, hasMore: offset + rows.length < total, totalPages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('GET /api/users failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * @openapi
 * /api/users/{id}/status:
 *   patch:
 *     tags: [Users]
 *     summary: Change a user's status (suspend, remove, or reactivate)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [active, suspended, removed] }
 *     responses:
 *       200: { description: Updated user }
 *       400: { description: Invalid id or status }
 *       404: { description: User not found }
 */
router.patch('/api/users/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user id' });
  if (!STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${STATUSES.join(', ')}` });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE users SET status = $1, updated_at = NOW() WHERE customer_id = $2
       RETURNING customer_id, full_name, email, phone, status, created_at`,
      [status, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/users/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to update user' });
  }
});

/**
 * @openapi
 * /api/users/{id}:
 *   delete:
 *     tags: [Users]
 *     summary: Permanently delete a user (cannot be undone)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       400: { description: Invalid id }
 *       404: { description: User not found }
 */
router.delete('/api/users/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid user id' });
  try {
    const { rowCount } = await pool.query('DELETE FROM users WHERE customer_id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'User not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/users/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete user' });
  }
});

module.exports = router;
