const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const s3 = require('../s3');

const router = Router();

// the columns shown for a course, in the list and at the top of its detail page
const COURSE_SELECT = `SELECT c.id, c.title, c.description, c.instructor_name, c.language, c.status, c.is_published, c.thumbnail_url,
              c.price::float, c.certificate_with_price::float, c.certificate_without_price::float,
              c.duration, c.duration_months, cat.name AS category, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id)::int AS sections,
              (SELECT COUNT(*) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id)::int AS videos,
              COALESCE((SELECT SUM(v.duration_seconds) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id), 0)::int AS duration_seconds,
              (SELECT COUNT(*) FROM course_resources r WHERE r.course_id = c.id)::int AS resources,
              (SELECT COUNT(DISTINCT e.customer_id) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed')::int AS students,
              COALESCE((SELECT SUM(e.amount_paid) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed'), 0)::float AS revenue,
              (SELECT COUNT(*) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::int AS review_count,
              (SELECT ROUND(AVG(rv.rating), 1) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::float AS avg_rating
         FROM courses c
         LEFT JOIN course_categories cat ON cat.id = c.category_id`;

/**
 * @openapi
 * /api/courses/summary:
 *   get:
 *     tags: [Courses]
 *     summary: Headline numbers for the Courses page
 *     responses:
 *       200: { description: "{ courses, published, sections, videos, durationSeconds, students, revenue, reviews, avgRating }" }
 */
router.get('/api/courses/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM courses)::int AS courses,
              (SELECT COUNT(*) FROM courses WHERE is_published)::int AS published,
              (SELECT COUNT(*) FROM course_sections)::int AS sections,
              (SELECT COUNT(*) FROM course_videos)::int AS videos,
              COALESCE((SELECT SUM(duration_seconds) FROM course_videos), 0)::int AS "durationSeconds",
              (SELECT COUNT(DISTINCT customer_id) FROM enrollments WHERE payment_status = 'completed' AND customer_id IS NOT NULL)::int AS students,
              COALESCE((SELECT SUM(amount_paid) FROM enrollments WHERE payment_status = 'completed'), 0)::float AS revenue,
              (SELECT COUNT(*) FROM course_reviews WHERE is_published)::int AS reviews,
              COALESCE((SELECT ROUND(AVG(rating), 1) FROM course_reviews WHERE is_published), 0)::float AS "avgRating"`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/courses/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the course summary' });
  }
});

/**
 * @openapi
 * /api/courses:
 *   get:
 *     tags: [Courses]
 *     summary: List courses with their content, students, revenue and rating
 *     responses:
 *       200: { description: All courses (there are only a few), newest first }
 */
router.get('/api/courses', async (req, res) => {
  try {
    const { rows } = await pool.query(`${COURSE_SELECT}
        ORDER BY c.is_published DESC, c.created_at DESC, c.id DESC`);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /api/courses failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

/**
 * @openapi
 * /api/courses/{id}:
 *   get:
 *     tags: [Courses]
 *     summary: One course's curriculum, learning points, practice files, software, reviews and promotions
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ course, sections (each with its videos), learningPoints, resources, software, reviews, promotions }" }
 *       404: { description: Course not found }
 */
router.get('/api/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid course id' });
  try {
    const header = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    if (!header.rowCount) return res.status(404).json({ error: 'Course not found' });

    const [sections, videos, learningPoints, resources, software, reviews, promotions] = await Promise.all([
      pool.query('SELECT id, title, description, position, is_published FROM course_sections WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT v.id, v.section_id, v.title, v.duration_seconds, v.position, v.is_free_preview, v.is_published, v.encoding_status,
                v.available_resolutions, v.thumbnail_url,
                (SELECT COUNT(*) FROM course_resources r WHERE r.video_id = v.id)::int AS resource_count
           FROM course_videos v JOIN course_sections s ON s.id = v.section_id
          WHERE s.course_id = $1 ORDER BY v.position, v.id`, [id]),
      pool.query('SELECT id, text, position FROM course_learning_points WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT r.id, r.title, r.description, r.resource_type, r.file_name, r.file_url, r.file_size::float AS file_size, r.mime_type, r.is_published,
                v.title AS video_title, s.title AS section_title, s.position AS section_position
           FROM course_resources r
           LEFT JOIN course_videos v ON v.id = r.video_id
           LEFT JOIN course_sections s ON s.id = v.section_id
          WHERE r.course_id = $1 ORDER BY s.position NULLS LAST, v.position NULLS LAST, r.position, r.id`, [id]),
      pool.query('SELECT id, name, description, platform, is_required, download_url, version, installation_instructions FROM course_software_links WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT rv.id, COALESCE(u.full_name, rv.reviewer_name) AS reviewer, rv.rating, rv.review_text, rv.is_published, rv.created_at
           FROM course_reviews rv LEFT JOIN users u ON u.customer_id = rv.customer_id
          WHERE rv.course_id = $1 ORDER BY rv.created_at DESC`, [id]),
      pool.query('SELECT id, title, sub_text, button_text, is_active, target_users FROM course_promotions WHERE course_id = $1 ORDER BY id', [id]),
    ]);

    const byId = new Map(sections.rows.map((s) => [String(s.id), { ...s, videos: [] }]));
    for (const v of videos.rows) byId.get(String(v.section_id))?.videos.push(v);
    res.json({
      course: header.rows[0],
      sections: [...byId.values()].map((s) => ({ ...s, duration_seconds: s.videos.reduce((n, v) => n + (v.duration_seconds || 0), 0) })),
      learningPoints: learningPoints.rows,
      resources: resources.rows,
      software: software.rows,
      reviews: reviews.rows,
      promotions: promotions.rows,
    });
  } catch (err) {
    console.error('GET /api/courses/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the course' });
  }
});

// ---------- creating a course ----------
const text = (v) => (v == null ? '' : String(v).trim());

/**
 * @openapi
 * /api/course-categories:
 *   get:
 *     tags: [Courses]
 *     summary: Course categories (for the category dropdown)
 *     responses:
 *       200: { description: Categories ordered by name }
 */
router.get('/api/course-categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM course_categories ORDER BY LOWER(name)');
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/course-categories failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * @openapi
 * /api/courses:
 *   post:
 *     tags: [Courses]
 *     summary: Create a course (a draft unless status is "published")
 *     description: >
 *       Creates the course and its "what students will learn" list. Sections and videos are added separately.
 *       Pick a category with category_id, or give new_category to create one. The price without certificate is the course price.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, instructor_name, price]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               instructor_name: { type: string }
 *               language: { type: string }
 *               category_id: { type: integer }
 *               new_category: { type: string }
 *               price: { type: number }
 *               certificate_with_price: { type: number, description: Must be at least the course price }
 *               access_months: { type: integer }
 *               status: { type: string, enum: [draft, published], default: draft }
 *               thumbnail_url: { type: string }
 *               learning_points: { type: array, items: { type: string }, description: Up to 20 points of up to 500 characters }
 *               sections: { type: array, items: { type: object, properties: { title: { type: string }, description: { type: string } } }, description: Up to 100 sections, created unpublished and in order }
 *               software: { type: array, items: { type: object, properties: { name: { type: string }, download_url: { type: string }, platform: { type: string }, is_required: { type: boolean }, description: { type: string } } } }
 *     responses:
 *       201: { description: The new course }
 *       400: { description: Validation failed }
 */
router.post('/api/courses', async (req, res) => {
  const b = req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {};
  const allowed = ['title', 'description', 'instructor_name', 'language', 'category_id', 'new_category', 'price', 'certificate_with_price', 'access_months', 'status', 'thumbnail_url', 'learning_points', 'sections', 'software'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) return res.status(400).json({ error: `Unknown fields: ${unknown.join(', ')}` });

  const fields = {};
  const title = text(b.title);
  if (!title) fields.title = 'is required';
  else if (title.length > 200) fields.title = 'must be at most 200 characters';

  const description = text(b.description);
  if (description.length > 5000) fields.description = 'must be at most 5000 characters';

  const instructor = text(b.instructor_name);
  if (!instructor) fields.instructor_name = 'is required';
  else if (instructor.length > 100) fields.instructor_name = 'must be at most 100 characters';

  const language = text(b.language);
  if (language.length > 50) fields.language = 'must be at most 50 characters';

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const price = num(b.price);
  if (price == null) fields.price = 'is required';
  else if (!Number.isFinite(price) || price < 0) fields.price = 'must be a number of 0 or more';

  const certPrice = num(b.certificate_with_price);
  if (certPrice != null) {
    if (!Number.isFinite(certPrice) || certPrice < 0) fields.certificate_with_price = 'must be a number of 0 or more';
    else if (fields.price === undefined && price != null && certPrice < price) fields.certificate_with_price = 'must be at least the course price';
  }

  const months = num(b.access_months);
  if (months != null && (!Number.isInteger(months) || months < 1 || months > 120)) fields.access_months = 'must be a whole number of months from 1 to 120';

  const status = b.status === undefined || b.status === '' ? 'draft' : b.status;
  if (!['draft', 'published'].includes(status)) fields.status = 'must be draft or published';

  const thumb = text(b.thumbnail_url);
  if (thumb && (thumb.length > 2000 || !/^https?:\/\//i.test(thumb))) fields.thumbnail_url = 'must be a link starting with http:// or https://';

  let points = [];
  if (b.learning_points !== undefined) {
    if (!Array.isArray(b.learning_points)) fields.learning_points = 'must be a list';
    else {
      points = b.learning_points.map(text).filter(Boolean);
      if (points.length > 20) fields.learning_points = 'can have at most 20 points';
      else if (points.some((p) => p.length > 500)) fields.learning_points = 'each point must be at most 500 characters';
    }
  }

  // curriculum: sections only (videos need an upload, so they are added to the course afterwards)
  const sections = [];
  if (b.sections !== undefined) {
    if (!Array.isArray(b.sections)) fields.sections = 'must be a list';
    else {
      const rows = b.sections.map((x) => ({ title: text(x && x.title), description: text(x && x.description) })).filter((x) => x.title || x.description);
      const bad = rows.findIndex((x) => !x.title || x.title.length > 200 || x.description.length > 2000);
      if (rows.length > 100) fields.sections = 'can have at most 100 sections';
      else if (bad >= 0) fields.sections = `section ${bad + 1} needs a title of up to 200 characters${rows[bad].description.length > 2000 ? ' and a description of up to 2000' : ''}`;
      else sections.push(...rows);
    }
  }

  // software the course needs
  const software = [];
  if (b.software !== undefined) {
    if (!Array.isArray(b.software)) fields.software = 'must be a list';
    else {
      const rows = b.software
        .map((x) => ({
          name: text(x && x.name), download_url: text(x && x.download_url), platform: text(x && x.platform),
          is_required: Boolean(x && x.is_required), description: text(x && x.description),
        }))
        .filter((x) => x.name || x.download_url || x.platform || x.description);
      const bad = rows.findIndex((x) => !x.name || x.name.length > 200 || !/^https?:\/\//i.test(x.download_url) || x.download_url.length > 2000 || x.platform.length > 50 || x.description.length > 5000);
      if (rows.length > 20) fields.software = 'can have at most 20 items';
      else if (bad >= 0) fields.software = `item ${bad + 1} needs a name and a download link starting with http:// or https://`;
      else software.push(...rows);
    }
  }

  const newCategory = text(b.new_category);
  const hasId = b.category_id !== undefined && b.category_id !== null && b.category_id !== '';
  if (hasId && newCategory) fields.category_id = 'choose an existing category or a new one, not both';
  else if (newCategory.length > 100) fields.new_category = 'must be at most 100 characters';
  else if (hasId && !(Number.isInteger(Number(b.category_id)) && Number(b.category_id) >= 1)) fields.category_id = 'is not valid';

  if (Object.keys(fields).length) return res.status(400).json({ error: 'Validation failed', fields });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const dup = await client.query('SELECT 1 FROM courses WHERE LOWER(title) = LOWER($1)', [title]);
    if (dup.rowCount) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Validation failed', fields: { title: 'is already used by another course' } });
    }

    let categoryId = null;
    if (hasId) {
      const cat = await client.query('SELECT id FROM course_categories WHERE id = $1', [Number(b.category_id)]);
      if (!cat.rowCount) {
        await client.query('ROLLBACK');
        return res.status(400).json({ error: 'Validation failed', fields: { category_id: 'does not exist' } });
      }
      categoryId = cat.rows[0].id;
    } else if (newCategory) {
      const found = await client.query('SELECT id FROM course_categories WHERE LOWER(name) = LOWER($1)', [newCategory]);
      categoryId = found.rowCount
        ? found.rows[0].id
        : (await client.query('INSERT INTO course_categories (name) VALUES ($1) RETURNING id', [newCategory])).rows[0].id;
    }

    const inserted = await client.query(
      `INSERT INTO courses (title, description, instructor_name, price, certificate_with_price, certificate_without_price,
                            is_published, status, category_id, thumbnail_url, language, duration_months)
       VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [title, description || null, instructor, price, certPrice, status === 'published', status, categoryId, thumb || null, language || null, months]
    );
    const id = inserted.rows[0].id;
    for (let i = 0; i < points.length; i++) {
      await client.query('INSERT INTO course_learning_points (course_id, text, position) VALUES ($1, $2, $3)', [id, points[i], i + 1]);
    }
    for (let i = 0; i < sections.length; i++) {
      await client.query('INSERT INTO course_sections (course_id, title, description, position) VALUES ($1, $2, $3, $4)',
        [id, sections[i].title, sections[i].description || null, i + 1]);
    }
    for (let i = 0; i < software.length; i++) {
      const x = software[i];
      await client.query(
        `INSERT INTO course_software_links (course_id, name, description, download_url, platform, is_required, position)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, x.name, x.description || null, x.download_url, x.platform || null, x.is_required, i + 1]
      );
    }
    await client.query('COMMIT');

    const { rows } = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/courses failed:', err.message);
    res.status(500).json({ error: 'Failed to create the course' });
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/courses/thumbnail:
 *   post:
 *     tags: [Courses]
 *     summary: Upload a course thumbnail
 *     description: multipart/form-data, field "file" (jpg, png, gif or webp, up to 5 MB). Returns the public link to put in thumbnail_url.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: "{ url }" }
 *       400: { description: No file, wrong type, or too large }
 */
const THUMB_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const THUMB_MAX_MB = 5;
const thumbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: THUMB_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    THUMB_TYPES.includes((file.originalname.split('.').pop() || '').toLowerCase()) ? cb(null, true) : cb(new Error('Use a jpg, png, gif or webp image')),
});

router.post('/api/courses/thumbnail', (req, res) => {
  if (!s3.configured) return res.status(503).json({ error: 'Image storage is not configured' });
  thumbUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The image is larger than ${THUMB_MAX_MB} MB` : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was sent' });
    try {
      const saved = await s3.uploadImage(req.file, s3.COURSE_THUMBNAIL_FOLDER);
      res.status(201).json({ url: saved.url });
    } catch (e) {
      console.error('POST /api/courses/thumbnail failed:', e.name, e.message);
      res.status(502).json({ error: 'Upload failed' });
    }
  });
});

module.exports = router;
