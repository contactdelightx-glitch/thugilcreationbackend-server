const { Router } = require('express');
const pool = require('../db');

const router = Router();
const FILTERS = ['reviewed', 'designs', 'general'];
const TABLES = {
  butta: 'butta_designs', brocade: 'brocade_designs', border: 'border_designs', pallu: 'pallu_designs',
  pattern: 'pattern_designs', full_set: 'full_set_designs', free_image: 'free_image_designs',
};
const CATEGORY_LABEL = { butta: 'Butta', brocade: 'Brocade', border: 'Border', pallu: 'Pallu', pattern: 'Pattern', full_set: 'Full Set', free_image: 'Free Image' };
// free_image_designs has no name column
const DESIGN_LOOKUP = Object.entries(TABLES)
  .map(([k, t]) => `SELECT '${k}' AS cat, id, ${k === 'free_image' ? 'NULL::varchar' : 'name'} AS name FROM ${t}`)
  .join(' UNION ALL ');

/**
 * @openapi
 * /api/ratings/summary:
 *   get:
 *     tags: [Ratings]
 *     summary: Rating totals and how many ratings each star count got
 *     responses:
 *       200: { description: "{ total, average, withReview, forDesigns, general, last30Days, distribution: {1..5} }" }
 */
router.get('/api/ratings/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS total,
              COALESCE(ROUND(AVG(rating), 2), 0)::float AS average,
              COUNT(*) FILTER (WHERE review IS NOT NULL)::int AS "withReview",
              COUNT(*) FILTER (WHERE design_id IS NOT NULL)::int AS "forDesigns",
              COUNT(*) FILTER (WHERE design_id IS NULL)::int AS general,
              COUNT(*) FILTER (WHERE created_at >= NOW() - INTERVAL '30 days')::int AS "last30Days",
              COUNT(*) FILTER (WHERE rating = 1)::int AS s1, COUNT(*) FILTER (WHERE rating = 2)::int AS s2,
              COUNT(*) FILTER (WHERE rating = 3)::int AS s3, COUNT(*) FILTER (WHERE rating = 4)::int AS s4,
              COUNT(*) FILTER (WHERE rating = 5)::int AS s5
         FROM saree_ratings`
    );
    const { s1, s2, s3, s4, s5, ...rest } = rows[0];
    res.json({ ...rest, distribution: { 1: s1, 2: s2, 3: s3, 4: s4, 5: s5 } });
  } catch (err) {
    console.error('GET /api/ratings/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the rating summary' });
  }
});

/**
 * @openapi
 * /api/ratings:
 *   get:
 *     tags: [Ratings]
 *     summary: List ratings, newest first
 *     parameters:
 *       - { in: query, name: filter, schema: { type: string, enum: [all, reviewed, designs, general], default: all }, description: reviewed = has a written review; designs = about a design; general = about the site }
 *       - { in: query, name: stars, schema: { type: integer, minimum: 1, maximum: 5 } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches the review text or the design name }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of ratings }
 */
router.get('/api/ratings', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();
  const stars = parseInt(req.query.stars, 10);

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(r.review ILIKE $${params.length} OR d.name ILIKE $${params.length})`);
  }
  if (stars >= 1 && stars <= 5) { params.push(stars); where.push(`r.rating = $${params.length}`); }
  if (req.query.filter === 'reviewed') where.push('r.review IS NOT NULL');
  if (req.query.filter === 'designs') where.push('r.design_id IS NOT NULL');
  if (req.query.filter === 'general') where.push('r.design_id IS NULL');
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = `FROM saree_ratings r LEFT JOIN (${DESIGN_LOOKUP}) d ON d.cat = r.design_category AND d.id = r.design_id`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT r.id, r.rating, r.review, r.created_at, r.design_id, r.design_category, d.name AS design_name
       ${from} ${clause}
       ORDER BY r.created_at DESC, r.id DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({
      data: rows.map((r) => ({ ...r, design_category_label: r.design_category ? CATEGORY_LABEL[r.design_category] : null })),
      offset, limit, total, hasMore: offset + rows.length < total,
    });
  } catch (err) {
    console.error('GET /api/ratings failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch ratings' });
  }
});

module.exports = router;
