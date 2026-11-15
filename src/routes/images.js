const { Router } = require('express');
const multer = require('multer');
const s3 = require('../s3');

const router = Router();

const MAX_MB = 25;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_MB * 1024 * 1024, files: 20 },
  fileFilter: (req, file, cb) =>
    s3.isImage(file.originalname) ? cb(null, true) : cb(new Error(`Not an allowed image type: ${file.originalname}`)),
});

const needS3 = (req, res, next) =>
  s3.configured ? next() : res.status(503).json({ error: 'Image storage is not configured' });

/**
 * @openapi
 * /api/images:
 *   get:
 *     tags: [Images]
 *     summary: List the images in the bucket (newest first)
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches the file name }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position; overrides page (used for infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 24, maximum: 100 } }
 *       - { in: query, name: refresh, schema: { type: boolean }, description: Skip the 60 second cache }
 *     responses:
 *       200: { description: A page of images, each with its public url }
 */
router.get('/api/images', needS3, async (req, res) => {
  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 24, 1), 100);
  const search = String(req.query.search || '').trim().toLowerCase();
  const offset = req.query.offset !== undefined ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : (page - 1) * limit;
  try {
    let items = await s3.listImages({ refresh: req.query.refresh === 'true' });
    if (search) items = items.filter((i) => i.name.toLowerCase().includes(search));
    const total = items.length;
    res.json({
      data: items.slice(offset, offset + limit),
      page,
      limit,
      offset,
      hasMore: offset + limit < total,
      total,
      totalPages: Math.max(Math.ceil(total / limit), 1),
    });
  } catch (err) {
    console.error('GET /api/images failed:', err.name, err.message);
    res.status(502).json({ error: 'Could not read the image bucket' });
  }
});

/**
 * @openapi
 * /api/images:
 *   post:
 *     tags: [Images]
 *     summary: Upload one or more images to the bucket
 *     description: multipart/form-data, field "files" (up to 20 files, 25 MB each; bmp, jpg, png, gif, webp).
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               files: { type: array, items: { type: string, format: binary } }
 *     responses:
 *       201: { description: The uploaded files with their urls }
 *       400: { description: No file, wrong type, or too large }
 */
router.post('/api/images', needS3, (req, res) => {
  upload.array('files', 20)(req, res, async (err) => {
    if (err) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? `File is larger than ${MAX_MB} MB` : err.message;
      return res.status(400).json({ error: message });
    }
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files were sent' });
    try {
      const uploaded = [];
      for (const f of req.files) uploaded.push(await s3.uploadImage(f));
      res.status(201).json({ uploaded });
    } catch (e) {
      console.error('POST /api/images failed:', e.name, e.message);
      res.status(502).json({ error: 'Upload to the image bucket failed' });
    }
  });
});

module.exports = router;
