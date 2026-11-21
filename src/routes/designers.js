const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const router = Router();

// every design table has a designer_email column, so one query counts a designer's designs across all of them
const DESIGN_TABLES = [
  'butta_designs', 'brocade_designs', 'border_designs', 'pallu_designs',
  'pattern_designs', 'full_set_designs', 'free_image_designs',
];
const COUNTS = DESIGN_TABLES.map((t) => `SELECT designer_email FROM ${t}`).join(' UNION ALL ');

/**
 * @openapi
 * /api/designers/{id}/designs:
 *   get:
 *     tags: [Designers]
 *     summary: The designs one client (designer) has uploaded, newest first, with just the design name and its picture
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches the design name }
 *       - { in: query, name: offset, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: "{ designer: { id, email }, data: [{ id, category, name, image_url }], total, hasMore }" }
 *       404: { description: No such client }
 */
router.get('/api/designers/:id/designs', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Client not found' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();
  try {
    const designer = (await pool.query('SELECT id, email FROM designers WHERE id = $1', [id])).rows[0];
    if (!designer) return res.status(404).json({ error: 'Client not found' });

    // the same columns from every design table (free images have no name); only a table name from the fixed list reaches the SQL
    const all = DESIGN_TABLES.map((t) => {
      const key = t.replace(/_designs$/, '');
      const name = key === 'free_image' ? 'NULL::varchar' : 'name';
      return `SELECT id, '${key}' AS category, ${name} AS name, split_part(btrim(image_url), ' ', 1) AS image_url, created_at, designer_email FROM ${t}`;
    }).join(' UNION ALL ');
    const params = [designer.email];
    let clause = 'WHERE LOWER(designer_email) = LOWER($1)';
    if (search) { params.push(`%${search}%`); clause += ` AND name ILIKE $${params.length}`; }

    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM (${all}) x ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT id, category, name, image_url FROM (${all}) x ${clause}
        ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ designer, data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/designers/:id/designs failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the client’s designs' });
  }
});

/**
 * @openapi
 * /api/designers:
 *   get:
 *     tags: [Designers]
 *     summary: List designers, with how many designs each has
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [all, active], default: all }, description: Use active for the designer dropdown }
 *     responses:
 *       200: { description: Designers ordered by email }
 */
router.get('/api/designers', async (req, res) => {
  const activeOnly = req.query.status === 'active';
  try {
    const { rows } = await pool.query(
      `SELECT d.id, d.email, d.type, d.status, d.created_at, COALESCE(c.n, 0)::int AS designs
         FROM designers d
         LEFT JOIN (
           SELECT LOWER(designer_email) AS email, COUNT(*) AS n FROM (${COUNTS}) x GROUP BY 1
         ) c ON c.email = LOWER(d.email)
        ${activeOnly ? "WHERE d.status = 'active'" : ''}
        ORDER BY LOWER(d.email)`
    );
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /api/designers failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch designers' });
  }
});

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_ROUNDS = 10;

/**
 * @openapi
 * /api/designers:
 *   post:
 *     tags: [Designers]
 *     summary: Create a client (designer account)
 *     description: >
 *       The admin chooses the email, password and status. The password is stored only as a bcrypt hash
 *       and is never returned. New clients are always regular designers (never the owner).
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string }
 *               password: { type: string, minLength: 8, maxLength: 72 }
 *               status: { type: string, enum: [active, suspended], default: active }
 *     responses:
 *       201: { description: The new client (without the password) }
 *       400: { description: Validation failed, e.g. email already registered }
 */
router.post('/api/designers', async (req, res) => {
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const unknown = Object.keys(body).filter((k) => !['email', 'password', 'status'].includes(k));
  if (unknown.length) return res.status(400).json({ error: `Unknown fields: ${unknown.join(', ')}` });

  const fields = {};
  const email = String(body.email ?? '').trim().toLowerCase();
  if (!email) fields.email = 'is required';
  else if (email.length > 255 || !EMAIL.test(email)) fields.email = 'must be a valid email address';

  const password = typeof body.password === 'string' ? body.password : '';
  if (!password) fields.password = 'is required';
  else if (password.length < 8) fields.password = 'must be at least 8 characters';
  else if (Buffer.byteLength(password) > 72) fields.password = 'must be at most 72 characters';

  const status = body.status === undefined || body.status === '' ? 'active' : body.status;
  if (!['active', 'suspended'].includes(status)) fields.status = 'must be active or suspended';

  if (Object.keys(fields).length) return res.status(400).json({ error: 'Validation failed', fields });

  try {
    const taken = await pool.query('SELECT 1 FROM designers WHERE LOWER(email) = $1', [email]);
    if (taken.rowCount) return res.status(400).json({ error: 'Validation failed', fields: { email: 'is already registered' } });

    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const { rows } = await pool.query(
      `INSERT INTO designers (email, type, status, password_hash) VALUES ($1, 'tenant', $2, $3)
       RETURNING id, email, type, status, created_at`,
      [email, status, hash]
    );
    res.status(201).json({ ...rows[0], designs: 0 });
  } catch (err) {
    // two requests with the same email at once: the unique index catches the second
    if (err.code === '23505') return res.status(400).json({ error: 'Validation failed', fields: { email: 'is already registered' } });
    console.error('POST /api/designers failed:', err.message);
    res.status(500).json({ error: 'Failed to create client' });
  }
});

const parseId = (req) => {
  const id = Number(req.params.id);
  return Number.isInteger(id) && id >= 1 ? id : null;
};

/**
 * @openapi
 * /api/designers/{id}/status:
 *   patch:
 *     tags: [Designers]
 *     summary: Suspend or reactivate a designer
 *     description: A suspended designer cannot be chosen when creating designs. Their existing designs are untouched. The owner (superadmin) cannot be suspended.
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
 *               status: { type: string, enum: [active, suspended] }
 *     responses:
 *       200: { description: Updated designer }
 *       400: { description: Invalid id or status, or the owner account }
 *       404: { description: Designer not found }
 */
router.patch('/api/designers/:id/status', async (req, res) => {
  const id = parseId(req);
  const { status } = req.body || {};
  if (!id) return res.status(400).json({ error: 'Invalid designer id' });
  if (!['active', 'suspended'].includes(status)) {
    return res.status(400).json({ error: 'status must be one of: active, suspended' });
  }
  try {
    const found = await pool.query('SELECT type FROM designers WHERE id = $1', [id]);
    if (!found.rowCount) return res.status(404).json({ error: 'Designer not found' });
    if (found.rows[0].type === 'superadmin') {
      return res.status(400).json({ error: 'The owner account cannot be suspended' });
    }
    const { rows } = await pool.query(
      `UPDATE designers SET status = $1, updated_at = NOW() WHERE id = $2 RETURNING id, email, type, status, created_at`,
      [status, id]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/designers/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to update designer' });
  }
});

/**
 * @openapi
 * /api/designers/{id}:
 *   delete:
 *     tags: [Designers]
 *     summary: Delete a designer (their designs are kept and handed to the owner)
 *     description: >
 *       Removes the designer, and in the same transaction changes designer_email on all of their
 *       designs to the owner's (superadmin) email. No design is deleted. The owner cannot be deleted.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ deleted, reassigned, reassignedTo }" }
 *       400: { description: Invalid id, or the owner account }
 *       404: { description: Designer not found }
 *       409: { description: No owner account to hand the designs to }
 */
router.delete('/api/designers/:id', async (req, res) => {
  const id = parseId(req);
  if (!id) return res.status(400).json({ error: 'Invalid designer id' });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const found = await client.query('SELECT id, email, type FROM designers WHERE id = $1 FOR UPDATE', [id]);
    if (!found.rowCount) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Designer not found' });
    }
    const designer = found.rows[0];
    if (designer.type === 'superadmin') {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'The owner account cannot be deleted' });
    }
    const owner = (await client.query(`SELECT email FROM designers WHERE type = 'superadmin' ORDER BY id LIMIT 1`)).rows[0];
    if (!owner) {
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'There is no owner account to hand the designs to' });
    }

    // keep every design; only the designer on it changes
    let reassigned = 0;
    for (const table of DESIGN_TABLES) {
      const r = await client.query(
        `UPDATE ${table} SET designer_email = $1, updated_at = NOW() WHERE LOWER(designer_email) = LOWER($2)`,
        [owner.email, designer.email]
      );
      reassigned += r.rowCount;
    }
    await client.query('DELETE FROM designers WHERE id = $1', [id]);
    await client.query('COMMIT');
    res.json({ deleted: designer.email, reassigned, reassignedTo: owner.email });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('DELETE /api/designers/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete designer' });
  } finally {
    client.release();
  }
});

module.exports = router;
