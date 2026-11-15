const { Router } = require('express');
const pool = require('../db');
const s3 = require('../s3');

const router = Router();

// The customer-facing storefront. Unlike /api/designs (the admin's view) this never returns the designer's
// email, notes, the original (unblurred) image or the free-image redirect: only what a shopper may see.
const CATEGORIES = {
  butta: { table: 'butta_designs', label: 'Butta' },
  pattern: { table: 'pattern_designs', label: 'Pattern' },
  full_set: { table: 'full_set_designs', label: 'Full Set' },
  brocade: { table: 'brocade_designs', label: 'Brocade' },
  pallu: { table: 'pallu_designs', label: 'Pallu' },
  border: { table: 'border_designs', label: 'Border' },
  free_image: { table: 'free_image_designs', label: 'Free Image' },
};
const LABELS = ['new', 'sale', 'featured'];

// The weaving details a buyer wants to see. Categories share some columns and full_set has its own,
// so every branch of the UNION returns the same list (NULL where a category has no such detail).
const SPEC_COLUMNS = ['cards', 'hooks', 'epi', 'ppi', 'harness_build', 'jacquard_type', 'body_epi', 'border_epi', 'br_hooks', 'by_hooks', 'image_type'];
const HAS = {
  standard: ['cards', 'hooks', 'epi', 'ppi', 'harness_build', 'image_type'],
  full_set: ['jacquard_type', 'ppi', 'body_epi', 'border_epi', 'br_hooks', 'by_hooks', 'image_type'],
  free_image: [],
};
const TYPES = { 'integer': 'integer', cards: 'integer', hooks: 'integer', epi: 'integer', ppi: 'integer', body_epi: 'integer', border_epi: 'integer' };

const publicSelect = (key) => {
  const { table } = CATEGORIES[key];
  const name = key === 'free_image' ? 'NULL::varchar' : 'name';
  const have = HAS[key === 'full_set' || key === 'free_image' ? key : 'standard'];
  const specs = SPEC_COLUMNS.map((c) => (have.includes(c) ? c : `NULL::${TYPES[c] || 'varchar'} AS ${c}`)).join(', ');
  return `SELECT id, product_id, ${name} AS name, image_url, label, listing_rate::float AS listing_rate,
                 final_price::float AS final_price, created_at, '${key}' AS category, ${specs}
            FROM ${table}`;
};

/**
 * @openapi
 * /api/store/categories:
 *   get:
 *     tags: [Store]
 *     summary: Saree styles with how many designs each has (for the shop's style pickers)
 *     responses:
 *       200: { description: "List of { key, label, count }" }
 */
router.get('/api/store/categories', async (req, res) => {
  try {
    const keys = Object.keys(CATEGORIES);
    const counts = await Promise.all(keys.map((k) => pool.query(`SELECT COUNT(*)::int AS n FROM ${CATEGORIES[k].table}`)));
    res.json(keys.map((k, i) => ({ key: k, label: CATEGORIES[k].label, count: counts[i].rows[0].n })));
  } catch (err) {
    console.error('GET /api/store/categories failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch styles' });
  }
});

/**
 * @openapi
 * /api/store/designs:
 *   get:
 *     tags: [Store]
 *     summary: Designs a shopper can browse, newest first (only public fields)
 *     parameters:
 *       - { in: query, name: category, schema: { type: string, enum: [all, butta, pattern, full_set, brocade, pallu, border, free_image], default: all } }
 *       - { in: query, name: label, schema: { type: string, enum: [new, sale, featured] } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches name or product id }
 *       - { in: query, name: offset, schema: { type: integer, default: 0 } }
 *       - { in: query, name: limit, schema: { type: integer, default: 12, maximum: 48 } }
 *     responses:
 *       200: { description: "{ data, total, offset, limit, hasMore }" }
 *       400: { description: Unknown category }
 */
router.get('/api/store/designs', async (req, res) => {
  const category = req.query.category || 'all';
  if (category !== 'all' && !CATEGORIES[category]) return res.status(400).json({ error: 'Unknown category' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 48);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (search) { params.push(`%${search}%`); where.push(`(name ILIKE $${params.length} OR product_id ILIKE $${params.length})`); }
  if (LABELS.includes(req.query.label)) { params.push(req.query.label); where.push(`label = $${params.length}`); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const keys = category === 'all' ? Object.keys(CATEGORIES) : [category];
  const source = `(${keys.map(publicSelect).join(' UNION ALL ')}) d`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${source} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT * FROM ${source} ${clause} ORDER BY created_at DESC, id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, total, offset, limit, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/store/designs failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch designs' });
  }
});

/**
 * @openapi
 * /api/store/courses/summary:
 *   get:
 *     tags: [Store]
 *     summary: Headline numbers for the public Courses page (published courses only)
 *     responses:
 *       200: { description: "{ courses, videos, durationSeconds, students, reviews, avgRating }" }
 */
router.get('/api/store/courses/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM courses WHERE is_published)::int AS courses,
              (SELECT COUNT(*) FROM course_videos v JOIN course_sections s ON s.id = v.section_id JOIN courses c ON c.id = s.course_id WHERE c.is_published)::int AS videos,
              COALESCE((SELECT SUM(v.duration_seconds) FROM course_videos v JOIN course_sections s ON s.id = v.section_id JOIN courses c ON c.id = s.course_id WHERE c.is_published), 0)::int AS "durationSeconds",
              (SELECT COUNT(DISTINCT e.customer_id) FROM enrollments e JOIN courses c ON c.id = e.course_id WHERE c.is_published AND e.payment_status = 'completed' AND e.customer_id IS NOT NULL)::int AS students,
              (SELECT COUNT(*) FROM course_reviews rv JOIN courses c ON c.id = rv.course_id WHERE c.is_published AND rv.is_published)::int AS reviews,
              (SELECT ROUND(AVG(rv.rating), 1) FROM course_reviews rv JOIN courses c ON c.id = rv.course_id WHERE c.is_published AND rv.is_published)::float AS "avgRating"`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/store/courses/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch course numbers' });
  }
});

/**
 * @openapi
 * /api/store/courses:
 *   get:
 *     tags: [Store]
 *     summary: The published courses a shopper can see (no video links, no revenue)
 *     responses:
 *       200: { description: "{ data: [course] }, newest first" }
 */
router.get('/api/store/courses', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.id, c.title, c.description, c.instructor_name, c.language, c.thumbnail_url, cat.name AS category,
              c.price::float AS price, c.certificate_with_price::float AS certificate_with_price, c.duration_months,
              (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id)::int AS sections,
              (SELECT COUNT(*) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id)::int AS videos,
              COALESCE((SELECT SUM(v.duration_seconds) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id), 0)::int AS duration_seconds,
              (SELECT COUNT(DISTINCT e.customer_id) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed' AND e.customer_id IS NOT NULL)::int AS students,
              (SELECT COUNT(*) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::int AS review_count,
              (SELECT ROUND(AVG(rv.rating), 1) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::float AS avg_rating
         FROM courses c LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE c.is_published
        ORDER BY c.created_at DESC, c.id DESC`
    );
    res.json({ data: await Promise.all(rows.map(async (r) => ({ ...r, thumbnail_url: await s3.freshUrl(r.thumbnail_url) }))) });
  } catch (err) {
    console.error('GET /api/store/courses failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

/**
 * @openapi
 * /api/store/courses/{id}:
 *   get:
 *     tags: [Store]
 *     summary: One published course with what a shopper may see before buying (syllabus titles, never video links)
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ course, learningPoints, sections: [{ title, videos: [{ title, duration_seconds, is_free_preview }] }], software, reviews }" }
 *       404: { description: Not found, or not published }
 */
router.get('/api/store/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Course not found' });
  try {
    const head = await pool.query(
      `SELECT c.id, c.title, c.description, c.instructor_name, c.language, c.thumbnail_url, cat.name AS category,
              c.price::float AS price, c.certificate_with_price::float AS certificate_with_price, c.duration_months,
              (SELECT COUNT(DISTINCT e.customer_id) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed' AND e.customer_id IS NOT NULL)::int AS students,
              (SELECT COUNT(*) FROM course_resources r WHERE r.course_id = c.id)::int AS resources
         FROM courses c LEFT JOIN course_categories cat ON cat.id = c.category_id
        WHERE c.id = $1 AND c.is_published`, [id]
    );
    if (!head.rowCount) return res.status(404).json({ error: 'Course not found' });

    const [points, sections, videos, software, reviews] = await Promise.all([
      pool.query('SELECT text FROM course_learning_points WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query('SELECT id, title, description FROM course_sections WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT v.section_id, v.title, v.duration_seconds, v.is_free_preview
           FROM course_videos v JOIN course_sections s ON s.id = v.section_id
          WHERE s.course_id = $1 ORDER BY v.position, v.id`, [id]),
      pool.query('SELECT name, platform, is_required FROM course_software_links WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT split_part(COALESCE(u.full_name, rv.reviewer_name, 'Student'), ' ', 1) AS reviewer, rv.rating, rv.review_text, rv.created_at
           FROM course_reviews rv LEFT JOIN users u ON u.customer_id = rv.customer_id
          WHERE rv.course_id = $1 AND rv.is_published ORDER BY rv.created_at DESC`, [id]),
    ]);

    const bySection = new Map(sections.rows.map((s) => [String(s.id), { title: s.title, description: s.description, videos: [] }]));
    for (const v of videos.rows) bySection.get(String(v.section_id))?.videos.push({ title: v.title, duration_seconds: v.duration_seconds || 0, is_free_preview: v.is_free_preview });
    const list = [...bySection.values()].map((s) => ({ ...s, duration_seconds: s.videos.reduce((n, v) => n + v.duration_seconds, 0) }));
    const rated = reviews.rows.filter((r) => r.rating);
    res.json({
      course: {
        ...head.rows[0],
        thumbnail_url: await s3.freshUrl(head.rows[0].thumbnail_url),
        sections: list.length,
        videos: list.reduce((n, s) => n + s.videos.length, 0),
        duration_seconds: list.reduce((n, s) => n + s.duration_seconds, 0),
        review_count: rated.length,
        avg_rating: rated.length ? Math.round((rated.reduce((n, r) => n + r.rating, 0) / rated.length) * 10) / 10 : null,
      },
      learningPoints: points.rows.map((p) => p.text),
      sections: list,
      software: software.rows,
      reviews: reviews.rows,
    });
  } catch (err) {
    console.error('GET /api/store/courses/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the course' });
  }
});

module.exports = router;
