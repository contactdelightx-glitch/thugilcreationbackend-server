const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const s3 = require('../s3');

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

// ---------- issuing: the instructor uploads the certificate file ----------
const FILE_TYPES = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
const MAX_MB = 10;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_MB * 1024 * 1024, files: 1 } });

// reads the "file" field and checks that it really is a PDF or image (by its first bytes, not just its name)
function takeFile(req, res, next) {
  upload.single('file')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The file is larger than ${MAX_MB} MB` : err.message });
    const f = req.file;
    if (!f) return res.status(400).json({ error: 'Choose the certificate file (PDF or image) to upload' });
    const ext = (f.originalname.split('.').pop() || '').toLowerCase();
    const b = f.buffer;
    const magic = { pdf: b.subarray(0, 5).toString() === '%PDF-', png: b.subarray(1, 4).toString() === 'PNG', jpg: b[0] === 0xff && b[1] === 0xd8, jpeg: b[0] === 0xff && b[1] === 0xd8, webp: b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP' };
    if (!FILE_TYPES[ext] || !magic[ext]) return res.status(400).json({ error: 'The certificate must be a PDF, PNG, JPG or WEBP file' });
    req.certFile = { ext, buffer: b, contentType: FILE_TYPES[ext] };
    next();
  });
}

async function saveFile(enrollmentId, file) {
  return s3.putPrivate(`certificates/${enrollmentId}-${Date.now()}.${file.ext}`, file.buffer, file.contentType);
}

/**
 * @openapi
 * /api/certificates/{enrollmentId}/issue:
 *   put:
 *     tags: [Certificates]
 *     summary: Approve a student's certificate request by uploading the certificate (PDF or image). The student can then download it.
 *     parameters:
 *       - { in: path, name: enrollmentId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, required: [file], properties: { file: { type: string, format: binary, description: "PDF, PNG, JPG or WEBP, up to 10 MB" } } }
 *     responses:
 *       200: { description: The certificate, now issued }
 *       400: { description: No file, wrong type or too large }
 *       404: { description: No request waiting for this enrolment }
 *       409: { description: Already issued }
 */
router.put('/api/certificates/:enrollmentId/issue', takeFile, async (req, res) => {
  const id = Number(req.params.enrollmentId);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Certificate request not found' });
  try {
    const cur = (await pool.query('SELECT status FROM certificates WHERE enrollment_id = $1', [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'This student has not requested a certificate' });
    if (cur.status === 'issued') return res.status(409).json({ error: 'This certificate was already issued' });
    const ref = await saveFile(id, req.certFile);
    const { rows } = await pool.query(
      `UPDATE certificates SET status = 'issued', certificate_number = $2, issued_at = NOW(), certificate_url = $3
        WHERE enrollment_id = $1 AND status = 'requested' RETURNING enrollment_id, status, certificate_number, issued_at`,
      [id, `CERT-${Date.now()}-${id}`, ref]
    );
    if (!rows[0]) { await s3.deletePrivate(ref).catch(() => {}); return res.status(409).json({ error: 'This certificate was already issued' }); }
    res.json(rows[0]);
  } catch (err) {
    console.error('PUT /api/certificates/:enrollmentId/issue failed:', err.message);
    res.status(500).json({ error: 'Could not save the certificate. Please try again.' });
  }
});

/**
 * @openapi
 * /api/certificates/{enrollmentId}/file:
 *   put:
 *     tags: [Certificates]
 *     summary: Replace the file of a certificate that was already issued
 *     parameters:
 *       - { in: path, name: enrollmentId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema: { type: object, required: [file], properties: { file: { type: string, format: binary } } }
 *     responses:
 *       200: { description: Saved }
 *       404: { description: Not issued }
 *   get:
 *     tags: [Certificates]
 *     summary: Open the certificate file of an issued certificate
 *     parameters:
 *       - { in: path, name: enrollmentId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The file }
 *       404: { description: No file }
 */
router.put('/api/certificates/:enrollmentId/file', takeFile, async (req, res) => {
  const id = Number(req.params.enrollmentId);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Certificate not found' });
  try {
    const cur = (await pool.query("SELECT certificate_url FROM certificates WHERE enrollment_id = $1 AND status = 'issued'", [id])).rows[0];
    if (!cur) return res.status(404).json({ error: 'This certificate has not been issued yet' });
    const ref = await saveFile(id, req.certFile);
    await pool.query('UPDATE certificates SET certificate_url = $2 WHERE enrollment_id = $1', [id, ref]);
    if (String(cur.certificate_url || '').startsWith('s3://')) await s3.deletePrivate(cur.certificate_url).catch(() => {}); // the replaced file
    res.json({ ok: true });
  } catch (err) {
    console.error('PUT /api/certificates/:enrollmentId/file failed:', err.message);
    res.status(500).json({ error: 'Could not save the certificate. Please try again.' });
  }
});

router.get('/api/certificates/:enrollmentId/file', async (req, res) => {
  const id = Number(req.params.enrollmentId);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Certificate not found' });
  try {
    const cur = (await pool.query("SELECT certificate_url FROM certificates WHERE enrollment_id = $1 AND status = 'issued'", [id])).rows[0];
    const url = cur && cur.certificate_url;
    if (!url) return res.status(404).json({ error: 'No certificate file' });
    if (url.startsWith('s3://')) {
      const f = await s3.getPrivate(url);
      res.setHeader('Content-Type', f.contentType);
      res.setHeader('Content-Disposition', 'inline');
      return res.send(f.body);
    }
    return res.redirect(await s3.freshUrl(url)); // a file from the old site: a fresh signed link
  } catch (err) {
    console.error('GET /api/certificates/:enrollmentId/file failed:', err.message);
    res.status(500).json({ error: 'Could not open the certificate' });
  }
});

module.exports = router;
