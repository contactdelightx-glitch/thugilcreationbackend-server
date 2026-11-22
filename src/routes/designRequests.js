const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const s3 = require('../s3');
const notify = require('../notify');
const { requireUser } = require('../auth');
const { activeSubscription } = require('./designPackages');

const router = Router();
// the steps a work goes through, in order; the customer sees how far it has got
const STATUSES = ['new', 'contacted', 'in_progress', 'review', 'done'];
const MAX_IMAGES = 2;
const MAX_MB = 5;
const TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

// ---------- finished work: files the admin sends back ----------
const MAX_WORK_FILES = 5;
const MAX_WORK_MB = 20;
const WORK_TYPES = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', pdf: 'application/pdf',
  zip: 'application/zip', psd: 'image/vnd.adobe.photoshop', ai: 'application/postscript', eps: 'application/postscript', cdr: 'application/vnd.corel-draw', tif: 'image/tiff', tiff: 'image/tiff',
  mp4: 'video/mp4', mov: 'video/quicktime' };
const workUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_WORK_MB * 1024 * 1024, files: MAX_WORK_FILES } });
// the admin form sends JSON, or multipart when finished files are attached
function takeWorkFiles(req, res, next) {
  if (!req.is('multipart/form-data')) return next();
  workUpload.array('files', MAX_WORK_FILES)(req, res, (err) => {
    if (err) {
      const msg = err.code === 'LIMIT_FILE_SIZE' ? `Each file must be ${MAX_WORK_MB} MB or smaller`
        : err.code === 'LIMIT_UNEXPECTED_FILE' || err.code === 'LIMIT_FILE_COUNT' ? `You can attach at most ${MAX_WORK_FILES} files at a time` : err.message;
      return res.status(400).json({ error: msg });
    }
    for (const f of req.files || []) {
      const ext = (f.originalname.split('.').pop() || '').toLowerCase();
      if (!WORK_TYPES[ext]) return res.status(400).json({ error: `${f.originalname}: send images, PDF, ZIP, PSD, AI, EPS, CDR or SVG files` });
    }
    next();
  });
}
const safeName = (n) => String(n).replace(/[^\w.\- ()]+/g, '_').slice(-150) || 'file';
const sendWorkFile = async (res, row) => {
  const file = await s3.getPrivate(row.ref);
  if (!file) return res.status(404).json({ error: 'File not found' });
  res.setHeader('Content-Type', row.content_type);
  res.setHeader('Content-Disposition', `attachment; filename="${safeName(row.name)}"`);
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(file.body);
};

// ---------- visitors: send a request ----------
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: MAX_IMAGES } });

// at most 20 works an hour from one address, so the form cannot be used to flood the admin
const hits = new Map();
const tooMany = (ip) => {
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  hits.set(ip, recent);
  return recent.length >= 20;
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
 *     summary: Contact designer, send a work to the designer with up to 2 pictures (5 MB each). Needs a login and a package
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
 *       401: { description: Not logged in }
 *       403: { description: No package yet (needs_package), or the package has used up its works }
 *       429: { description: Too many requests from this address }
 */
router.post('/api/store/design-requests', requireUser, takeImages, async (req, res) => {
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

  const customerId = Number(req.customerId);
  const source = b.source === 'app' ? 'app' : 'web';

  // work can only be sent under a package: its price terms and delivery days are fixed here
  const sub = await activeSubscription(customerId);
  if (!sub) return res.status(403).json({ error: 'Choose a package first, then send your work.', needs_package: true });
  if (sub.max_requests && sub.used >= sub.max_requests) return res.status(403).json({ error: `Your package allows ${sub.max_requests} ${sub.max_requests === 1 ? 'work' : 'works'} and you have sent them all. You can choose a new package when it ends.` });

  let id;
  const refs = [];
  try {
    id = (await pool.query(
      `INSERT INTO design_requests (customer_id, name, email, phone, requirement, notes, source, subscription_id, package_name, cost_percent, delivery_days, due_date)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, CURRENT_DATE + $11::int) RETURNING id`,
      [customerId, name, email, phone, requirement, notes || null, source, sub.id, sub.package_name, sub.cost_percent, sub.delivery_days]
    )).rows[0].id;
    await pool.query(`INSERT INTO design_request_updates (request_id, status, message) VALUES ($1, 'new', 'We received your work.')`, [id]);
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
  notify.designRequestReceived({ id, name, email, phone, requirement, notes, imageCount: refs.length, source, packageName: sub.package_name, deliveryDays: sub.delivery_days, costPercent: sub.cost_percent });
  res.status(201).json({ id });
});

/**
 * @openapi
 * /api/store/design-requests/mine:
 *   get:
 *     tags: [Design requests]
 *     summary: The logged-in customer's own works, newest first, each with its progress steps
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ data: [{ id, requirement, status, package_name, due_date, quoted_price, normal_cost, cost_percent, image_count, created_at, updates: [{ status, message, created_at }] }] }" }
 */
router.get('/api/store/design-requests/mine', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, requirement, notes, status, package_name, cost_percent, delivery_days, to_char(due_date, 'YYYY-MM-DD') AS due_date,
              normal_cost::float AS normal_cost, quoted_price::float AS quoted_price, cardinality(images) AS image_count, created_at, delivered_at,
              COALESCE((SELECT json_agg(json_build_object('status', u.status, 'message', u.message, 'created_at', u.created_at,
                  'files', COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'size', f.size) ORDER BY f.id) FROM design_request_files f WHERE f.update_id = u.id), '[]'::json)) ORDER BY u.created_at, u.id)
                          FROM design_request_updates u WHERE u.request_id = r.id), '[]'::json) AS updates
         FROM design_requests r WHERE r.customer_id = $1 ORDER BY r.created_at DESC, r.id DESC LIMIT 100`, [req.customerId]);
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/store/design-requests/mine failed:', err.message);
    res.status(500).json({ error: 'Failed to load your works' });
  }
});

/**
 * @openapi
 * /api/store/design-requests/{id}/files/{fileId}:
 *   get:
 *     tags: [Design requests]
 *     summary: Download a finished file the designer sent for one of the customer's own works
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *       - { in: path, name: fileId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The file as a download }
 *       404: { description: No such file for this customer }
 */
router.get('/api/store/design-requests/:id/files/:fileId', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) return res.status(404).json({ error: 'Not found' });
  try {
    const row = (await pool.query(
      `SELECT f.ref, f.name, f.content_type FROM design_request_files f JOIN design_requests r ON r.id = f.request_id
        WHERE f.id = $1 AND f.request_id = $2 AND r.customer_id = $3`, [fileId, id, req.customerId])).rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    await sendWorkFile(res, row);
  } catch (err) {
    console.error('GET /api/store/design-requests/:id/files/:fileId failed:', err.message);
    res.status(500).json({ error: 'Could not load the file' });
  }
});

// ---------- admin: follow up ----------
const COLUMNS = `id, customer_id, name, email, phone, requirement, notes, cardinality(images) AS image_count, source, status, admin_note, created_at, updated_at,
  package_name, cost_percent, delivery_days, to_char(due_date, 'YYYY-MM-DD') AS due_date, normal_cost::float AS normal_cost, quoted_price::float AS quoted_price, delivered_at,
  COALESCE((SELECT json_agg(json_build_object('id', f.id, 'name', f.name, 'size', f.size, 'created_at', f.created_at) ORDER BY f.id) FROM design_request_files f WHERE f.request_id = design_requests.id), '[]'::json) AS files`;

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
              COUNT(*) FILTER (WHERE status = 'in_progress')::int AS in_progress,
              COUNT(*) FILTER (WHERE status = 'review')::int AS review,
              COUNT(*) FILTER (WHERE status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE status <> 'done' AND due_date < CURRENT_DATE)::int AS overdue,
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

router.get('/api/design-requests/:id/files/:fileId', async (req, res) => {
  const id = Number(req.params.id);
  const fileId = Number(req.params.fileId);
  if (!Number.isInteger(id) || !Number.isInteger(fileId)) return res.status(404).json({ error: 'Not found' });
  try {
    const row = (await pool.query('SELECT ref, name, content_type FROM design_request_files WHERE id = $1 AND request_id = $2', [fileId, id])).rows[0];
    if (!row) return res.status(404).json({ error: 'File not found' });
    await sendWorkFile(res, row);
  } catch (err) {
    console.error('GET /api/design-requests/:id/files/:fileId failed:', err.message);
    res.status(500).json({ error: 'Could not load the file' });
  }
});

/**
 * @openapi
 * /api/design-requests/{id}:
 *   patch:
 *     tags: [Design requests]
 *     summary: Move a request to its next step with a message and finished files (up to 5, 20 MB each, send as multipart field files) for the customer, set its due date and normal cost (the customer's quote follows from the package), and keep a private note
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema: { type: object, properties: { status: { type: string, enum: [new, contacted, in_progress, review, done] }, message: { type: string, maxLength: 1000 }, due_date: { type: string, format: date }, normal_cost: { type: number, nullable: true }, admin_note: { type: string, maxLength: 2000 } } }
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
router.patch('/api/design-requests/:id', takeWorkFiles, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request id' });
  const b = req.body || {};
  const sets = [];
  const params = [];
  const add = (column, value) => { params.push(value); sets.push(`${column} = $${params.length}`); };

  if (b.status !== undefined) {
    if (!STATUSES.includes(b.status)) return res.status(400).json({ error: `status must be one of ${STATUSES.join(', ')}` });
    add('status', b.status);
    sets.push(b.status === 'done' ? 'delivered_at = COALESCE(delivered_at, NOW())' : 'delivered_at = NULL');
  }
  if (b.admin_note !== undefined) {
    const note = String(b.admin_note ?? '').trim();
    if (note.length > 2000) return res.status(400).json({ error: 'The note can be at most 2000 characters' });
    add('admin_note', note || null);
  }
  const message = b.message === undefined ? '' : String(b.message ?? '').trim();
  if (message.length > 1000) return res.status(400).json({ error: 'The message can be at most 1000 characters' });
  if (b.due_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.due_date)) || Number.isNaN(Date.parse(b.due_date))) return res.status(400).json({ error: 'The due date must be a date like 2026-12-31' });
    add('due_date', b.due_date);
  }
  let newCost;
  if (b.normal_cost !== undefined) {
    if (b.normal_cost === null || b.normal_cost === '') newCost = null;
    else { newCost = Number(b.normal_cost); if (!Number.isFinite(newCost) || newCost < 0 || newCost > 10000000) return res.status(400).json({ error: 'The normal cost must be 0 or more' }); newCost = Math.round(newCost * 100) / 100; }
    add('normal_cost', newCost);
    // the customer pays the package's share of the normal cost
    sets.push(newCost === null ? 'quoted_price = NULL' : `quoted_price = ROUND(($${params.length}::numeric * COALESCE(cost_percent, 100)) / 100, 2)`);
  }
  const workFiles = req.files || [];
  if (!sets.length && !message && !workFiles.length) return res.status(400).json({ error: 'Nothing to change' });

  // finished files go to private storage first; they are removed again if saving fails
  const saved = [];
  try {
    for (const f of workFiles) {
      const ext = (f.originalname.split('.').pop() || '').toLowerCase();
      saved.push({ name: f.originalname.slice(-250), size: f.size, type: WORK_TYPES[ext],
        ref: await s3.putPrivate(`request-work/${id}-${Date.now()}-${saved.length + 1}.${ext}`, f.buffer, WORK_TYPES[ext]) });
    }
  } catch (err) {
    for (const x of saved) await s3.deletePrivate(x.ref).catch(() => {});
    console.error('PATCH /api/design-requests/:id upload failed:', err.message);
    return res.status(502).json({ error: 'Could not store the files. Please try again.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const before = (await client.query('SELECT status FROM design_requests WHERE id = $1 FOR UPDATE', [id])).rows[0];
    if (!before) { await client.query('ROLLBACK'); for (const x of saved) await s3.deletePrivate(x.ref).catch(() => {}); return res.status(404).json({ error: 'Request not found' }); }
    params.push(id);
    const { rows } = await client.query(`UPDATE design_requests SET ${[...sets, 'updated_at = NOW()'].join(', ')} WHERE id = $${params.length} RETURNING ${COLUMNS}`, params);
    const changed = b.status !== undefined && b.status !== before.status;
    // a step change, a message or finished files are part of the progress the customer sees (and they are emailed)
    if (changed || message || saved.length) {
      const upd = (await client.query('INSERT INTO design_request_updates (request_id, status, message) VALUES ($1, $2, $3) RETURNING id', [id, rows[0].status, message || null])).rows[0].id;
      for (const x of saved) await client.query('INSERT INTO design_request_files (request_id, update_id, name, ref, content_type, size) VALUES ($1, $2, $3, $4, $5, $6)', [id, upd, x.name, x.ref, x.type, x.size]);
    }
    await client.query('COMMIT');
    if (changed || message || saved.length) notify.designRequestUpdated({ id, status: rows[0].status, message, statusChanged: changed, fileCount: saved.length });
    const out = (await pool.query(`SELECT ${COLUMNS} FROM design_requests WHERE id = $1`, [id])).rows[0];
    res.json(out);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    for (const x of saved) await s3.deletePrivate(x.ref).catch(() => {});
    console.error('PATCH /api/design-requests/:id failed:', err.message);
    res.status(500).json({ error: 'Could not save the change' });
  } finally {
    client.release();
  }
});

router.delete('/api/design-requests/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid request id' });
  try {
    const sent = (await pool.query('SELECT ref FROM design_request_files WHERE request_id = $1', [id])).rows;
    const { rows } = await pool.query('DELETE FROM design_requests WHERE id = $1 RETURNING images', [id]);
    if (!rows[0]) return res.status(404).json({ error: 'Request not found' });
    for (const f of sent) await s3.deletePrivate(f.ref).catch(() => {});
    for (const ref of rows[0].images) await s3.deletePrivate(ref).catch(() => {});
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/design-requests/:id failed:', err.message);
    res.status(500).json({ error: 'Could not delete the request' });
  }
});

module.exports = router;
