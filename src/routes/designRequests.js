const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const s3 = require('../s3');
const notify = require('../notify');
const { verifyToken } = require('../auth');

const router = Router();
const STATUSES = ['new', 'contacted', 'done'];
const MAX_IMAGES = 2;
const MAX_MB = 5;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ---------- visitors: send a request ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_IMAGES } });

// at most 5 requests an hour from one address, so the form cannot be used to flood the admin
const hits = new Map();
const tooMany = (ip) => {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  hits.set(ip, recent);
  return recent.length >= 5;
};

// reads the "images" field and checks each file really is a JPG, PNG or WEBP (by its first bytes, not just its name)
function takeImages(req, res, next) {
  upload.array('images', MAX_IMAGES)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each picture must be ${MAX_MB} MB or smaller`
        : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT' ? `You can attach at most ${MAX_IMAGES} pictures` : err.message;
      return res.status(400).json({ error: msg });
    }
    const files = [];
    for (const f of req.files || []) {
      const ext = (f.originalname.split('.').pop() || '').toLowerCase();
      const b = f.buffer;
      const magic = { jpg: b[0] === 0xff && b[1] === 0xd8, jpeg: b[0] === 0xff && b[1] === 0xd8, png: b.subarray(1, 4).toString() === 'PNG', webp: b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
      if (!TYPES[ext] || !magic[ext]) return res.status(400).json({ error: 'Pictures must be JPG, PNG or WEBP files' });
      files.push({ ext: ext === 'jpeg' ? 'jpg' : ext, buffer: b, contentType: TYPES[ext] });
    }
    req.pictures = files;
    next();
  });
}

/**
 * @openapi
 * /api/store/design-requests:
 *   post:
 *     tags: [Design requests]
 *     summary: Contact designer, send the admin a request for design work with up to 2 pictures (5 MB each)
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [name, phone, email, requirement]
 *             properties:
 *               name: { type: string }
 *               phone: { type: string }
 *               email: { type: string }
 *               requirement: { type: string, description: What they need, 10 to 2000 characters }
 *               notes: { type: string }
 *               source: { type: string, enum: [web, app] }
 *               images: { type: array, maxItems: 2, items: { type: string, format: binary } }
 *     responses:
 *       201: { description: "{ id }" }
 *       400: { description: Missing or invalid details, or a bad picture }
 *       429: { description: Too many requests from this address }
 */
router.post('/api/store/design-requests', takeImages, async (req, res) => {
  if (tooMany(req.ip)) return res.status(429).json({ error: 'You have sent several requests already. Please try again in a while.' });
  const b = req.body || {};
  const name = String(b.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(b.email ?? '').trim();
  const phone = String(b.phone ?? '').trim();
  const requirement = String(b.requirement ?? '').trim();
  const notes = String(b.notes ?? '').trim();
  const fields = {};
  if (name.length < 2 || name.length > 150) fields.name = 'Enter your name';
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email) || email.length > 255) fields.email = 'Enter a valid email address';
  const digits = phone.replace(/\D/g, '');
  if (!/^[+\d][\d\s()-]*$/.test(phone) || digits.length < 7 || digits.length > 15) fields.phone = 'Enter a valid phone number';
  if (requirement.length < 10) fields.requirement = 'Tell us what you need (at least 10 characters)';
  if (requirement.length > 2000) fields.requirement = 'Please keep it under 2000 characters';
  if (notes.length > 2000) fields.notes = 'Please keep the notes under 2000 characters';
  if (Object.keys(fields).length) return res.status(400).json({ error: Object.values(fields)[0], fields });

  let customerId = null;
  try { customerId = Number(verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, ''))) || null; } catch { /* not logged in is fine */ }
  const source = b.source === 'app' ? 'app' : 'web';

  let id;
  const refs = [];
  try {
    id = (await pool.query(
      `INSERT INTO design_requests (customer_id, name, email, phone, requirement, notes, source) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
      [customerId, name, email, phone, requirement, notes || null, source]
    )).rows[0].id;
    hits.get(req.ip)?.push(Date.now()) ?? hits.set(req.ip, [Date.now()]);
    for (const [n, f] of req.pictures.entries()) refs.push(await s3.putPrivate(`requests/${id}-${n + 1}-${Date.now()}.${f.ext}`, f.buffer, f.contentType));
    if (refs.length) await pool.query('UPDATE design_requests SET images = $2 WHERE id = $1', [id, refs]);
  } catch (err) {
    console.error('POST /api/store/design-requests failed:', err.message);
    if (id) {
      await pool.query('DELETE FROM design_requests WHERE id = $1', [id]).catch(() => {});
      for (const r of refs) await s3.deletePrivate(r).catch(() => {});
    }
    return res.status(502).json({ error: 'Could not send your request. Please try again in a moment.' });
  }
  notify.designRequestReceived({ id, name, email, phone, requirement, notes, imageCount: refs.length, source });
  res.status(201).json({ id });
});

// ---------- admin: follow up ----------
const COLUMNS = `id, customer_id, name, email, phone, requirement, notes, cardinality(images) AS image_count, source, status, admin_note, created_at, updated_at`;

/**
 * @openapi
 * /api/design-requests/summary:
 *   get:
 *     tags: [Design requests]
 *     summary: How many design requests are new, being handled and done
 *     responses:
 *       200: { description: "{ total, new, contacted, done, oldestNew }" }
 */
router.get('/api/design-requests/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'new')::int AS "new",
              COUNT(*) FILTER (WHERE status = 'contacted')::int AS contacted,
              COUNT(*) FILTER (WHERE status = 'done')::int AS done,
              MIN(created_at) FILTER (WHERE status = 'new') AS "oldestNew"
         FROM design_requests`);
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/design-requests/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the request summary' });
  }
});

/**
 * @openapi
 * /api/design-requests:
 *   get:
 *     tags: [Design requests]
 *     summary: List design requests. New ones first (oldest first), then the rest newest first
 *     parameters:
 *       - { in: query, name: status, schema: { type: string, enum: [all, new, contacted, done], default: all } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, email, phone, requirement or notes }
 *       - { in: query, name: offset, schema: { type: integer } }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of requests }
 */
router.get('/api/design-requests', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();
  const where = [];
  const params = [];
  if (search) { params.push(`%${search}%`); where.push(`(name ILIKE $1 OR email ILIKE $1 OR phone ILIKE $1 OR requirement ILIKE $1 OR notes ILIKE $1)`); }
  if (STATUSES.includes(req.query.status)) { params.push(req.query.status); where.push(`status = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM design_requests ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM design_requests ${clause}
        ORDER BY (status <> 'new'), CASE WHEN status = 'new' THEN created_at END ASC, created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, limit, offset]);
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/design-requests failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch design requests' });
  }
});

/**
 * @openapi
 * /api/design-requests/{id}/images/{n}:
 *   get:
 *     tags: [Design requests]
 *     summary: One of the pictures the visitor attached (n = 1 or 2)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: n, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The picture }
 *       404: { description: No such picture }
 */
router.get('/api/design-requests/:id/images/:n', async (req, res) => {
  const id = Number(req.params.id);
  const n = Number(req.params.n);
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(n) || n < 1 || n > MAX_IMAGES) return res.status(404).json({ error: 'Not found' });
  try {
    const row = (await pool.query('SELECT images FROM design_requests WHERE id = $1', [id])).rows[0];
    const ref = row && row.images[n - 1];
    if (!ref) return res.status(404).json({ error: 'No such picture' });
    const file = await s3.getPrivate(ref);
    if (!file) return res.status(404).json({ error: 'No such picture' });
    res.setHeader('Content-Type', file.contentType);
    res.setHeader('Cache-Control', 'private, max-age=300');
    res.send(file.body);
  } catch (err) {
    console.error('GET /api/design-requests/:id/images/:n failed:', err.message);
    res.status(500).json({ error: 'Could not load the picture' });
  }
});

/**
 * @openapi
 * /api/design-requests/{id}:
 *   patch:
 *     tags: [Design requests]
 *     summary: Change a request's status and/or your private note on it
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { status: { type: string, enum: [new, contacted, done] }, admin_note: { type: string, maxLength: 2000 } } }
 *     responses:
 *       200: { description: The updated request }
 *       400: { description: Nothing to change, or invalid }
 *       404: { description: Not found }
 *   delete:
 *     tags: [Design requests]
 *     summary: Delete a request and its pictures
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 */
router.patch('/api/design-requests/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request id' });
  const sets = [];
  const params = [];
  if (req.body && req.body.status !== undefined) {
    if (!STATUSES.includes(req.body.status)) return res.status(400).json({ error: 'status must be new, contacted or done' });
    params.push(req.body.status); sets.push(`status = $${params.length}`);
  }
  if (req.body && req.body.admin_note !== undefined) {
    const note = String(req.body.admin_note ?? '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note can be at most 2000 characters' });
    params.push(note || null); sets.push(`admin_note = $${params.length}`);
  }
  if (!sets.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    params.push(id);
    const { rows } = await pool.query(`UPDATE design_requests SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${params.length} RETURNING ${COLUMNS}`, params);
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/design-requests/:id failed:', err.message);
    res.status(500).json({ error: 'Could not save the change' });
  }
});

router.delete('/api/design-requests/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request id' });
  try {
    const { rows } = await pool.query('DELETE FROM design_requests WHERE id = $1 RETURNING images', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    for (const ref of rows[0].images) await s3.deletePrivate(ref).catch(() => {});
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/design-requests/:id failed:', err.message);
    res.status(500).json({ error: 'Could not delete the request' });
  }
});

module.exports = router;
