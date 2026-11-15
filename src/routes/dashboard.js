const { Router } = require('express');
const pool = require('../db');

const router = Router();
const TZ = 'Asia/Kolkata';
const CATEGORY_TABLES = {
  butta: 'butta_designs', brocade: 'brocade_designs', border: 'border_designs', pallu: 'pallu_designs',
  pattern: 'pattern_designs', full_set: 'full_set_designs', free_image: 'free_image_designs',
};
const LABELS = { butta: 'Butta', brocade: 'Brocade', border: 'Border', pallu: 'Pallu', pattern: 'Pattern', full_set: 'Full Set', free_image: 'Free Image' };

/**
 * @openapi
 * /api/dashboard:
 *   get:
 *     tags: [Dashboard]
 *     summary: Everything the admin dashboard shows besides the month trend cards
 *     description: >
 *       Site totals (design sales and course sales), the last 12 months of sales, what needs attention,
 *       best sellers, newest orders and enrolments, the catalogue size and the rating spread.
 *       Only captured orders and completed course payments count as sales.
 *     responses:
 *       200: { description: Dashboard data }
 */
router.get('/api/dashboard', async (req, res) => {
  try {
    const one = async (sql, params) => (await pool.query(sql, params)).rows;
    const designCounts = Promise.all(Object.entries(CATEGORY_TABLES).map(async ([key, table]) => ({
      key, label: LABELS[key], count: (await pool.query(`SELECT COUNT(*)::int AS n FROM ${table}`)).rows[0].n,
    })));

    const [totals, months, attention, topDesigns, topCourses, recentOrders, recentEnrollments, pendingDoubts, ratings, people, designs] = await Promise.all([
      one(`SELECT
             (SELECT COALESCE(SUM(total), 0)::float FROM orders WHERE payment_status = 'captured') AS "designRevenue",
             (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'captured') AS "designOrders",
             (SELECT COALESCE(SUM(amount_paid), 0)::float FROM enrollments WHERE payment_status = 'completed') AS "courseRevenue",
             (SELECT COUNT(*)::int FROM enrollments WHERE payment_status = 'completed') AS "courseSales"`),
      // 12 months of sales, oldest first, every month present even with no sales
      one(`WITH m AS (
             SELECT to_char(d, 'YYYY-MM') AS month
               FROM generate_series(date_trunc('month', NOW() AT TIME ZONE $1) - INTERVAL '11 months', date_trunc('month', NOW() AT TIME ZONE $1), INTERVAL '1 month') d)
           SELECT m.month,
                  COALESCE((SELECT SUM(total) FROM orders o WHERE o.payment_status = 'captured' AND to_char(o.created_at AT TIME ZONE $1, 'YYYY-MM') = m.month), 0)::float AS designs,
                  COALESCE((SELECT SUM(amount_paid) FROM enrollments e WHERE e.payment_status = 'completed' AND to_char(e.enrolled_at AT TIME ZONE $1, 'YYYY-MM') = m.month), 0)::float AS courses
             FROM m ORDER BY m.month`, [TZ]),
      one(`SELECT
             (SELECT COUNT(*)::int FROM course_doubts WHERE status = 'pending') AS "pendingDoubts",
             (SELECT COUNT(*)::int FROM certificates WHERE status = 'requested') AS "certificateRequests",
             (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'pending') AS "pendingOrders",
             (SELECT COUNT(*)::int FROM orders WHERE payment_status = 'failed') AS "failedOrders",
             (SELECT COUNT(*)::int FROM enrollments WHERE payment_status = 'failed') AS "failedEnrollments",
             (SELECT COUNT(*)::int FROM courses WHERE NOT is_published) AS "draftCourses"`),
      one(`SELECT i.design_name AS name, i.design_category AS category, MAX(i.image_url) AS image_url,
                  COUNT(*)::int AS sold, COALESCE(SUM(i.final_price), 0)::float AS revenue
             FROM order_items i JOIN orders o ON o.id = i.order_id AND o.payment_status = 'captured'
            GROUP BY i.design_name, i.design_category ORDER BY sold DESC, revenue DESC LIMIT 5`),
      one(`SELECT c.id, c.title, COUNT(e.id)::int AS sales, COALESCE(SUM(e.amount_paid), 0)::float AS revenue
             FROM courses c LEFT JOIN enrollments e ON e.course_id = c.id AND e.payment_status = 'completed'
            GROUP BY c.id, c.title ORDER BY revenue DESC, c.id LIMIT 5`),
      one(`SELECT o.id, COALESCE(u.full_name, u.email, o.mobile_number) AS customer, o.total::float AS total, o.payment_status, o.created_at,
                  (SELECT COUNT(*)::int FROM order_items i WHERE i.order_id = o.id) AS items
             FROM orders o LEFT JOIN users u ON u.customer_id = o.customer_id ORDER BY o.created_at DESC, o.id DESC LIMIT 6`),
      one(`SELECT e.id, COALESCE(u.full_name, e.student_name) AS student, c.title AS course, e.amount_paid::float AS amount, e.payment_status, e.enrolled_at
             FROM enrollments e JOIN courses c ON c.id = e.course_id LEFT JOIN users u ON u.customer_id = e.customer_id
            ORDER BY e.enrolled_at DESC, e.id DESC LIMIT 6`),
      one(`SELECT d.id, COALESCE(u.full_name, d.student_name) AS student, c.title AS course, d.question, d.created_at
             FROM course_doubts d JOIN courses c ON c.id = d.course_id LEFT JOIN users u ON u.customer_id = d.customer_id
            WHERE d.status = 'pending' ORDER BY d.created_at ASC LIMIT 4`),
      one(`SELECT COUNT(*)::int AS total, COALESCE(ROUND(AVG(rating), 1), 0)::float AS average,
                  COUNT(*) FILTER (WHERE rating = 5)::int AS r5, COUNT(*) FILTER (WHERE rating = 4)::int AS r4, COUNT(*) FILTER (WHERE rating = 3)::int AS r3,
                  COUNT(*) FILTER (WHERE rating = 2)::int AS r2, COUNT(*) FILTER (WHERE rating = 1)::int AS r1
             FROM saree_ratings`),
      one(`SELECT (SELECT COUNT(*)::int FROM users) AS users,
                  (SELECT COUNT(*)::int FROM designers) AS clients,
                  (SELECT COUNT(DISTINCT customer_id)::int FROM enrollments WHERE payment_status = 'completed' AND customer_id IS NOT NULL) AS students,
                  (SELECT COUNT(*)::int FROM courses) AS courses,
                  (SELECT COUNT(*)::int FROM courses WHERE is_published) AS "publishedCourses",
                  (SELECT COUNT(*)::int FROM certificates WHERE status = 'issued') AS "certificatesIssued"`),
      designCounts,
    ]);

    const r = ratings[0];
    res.json({
      totals: totals[0],
      months,
      attention: attention[0],
      topDesigns,
      topCourses,
      recentOrders,
      recentEnrollments,
      pendingDoubts,
      ratings: { total: r.total, average: r.average, distribution: { 5: r.r5, 4: r.r4, 3: r.r3, 2: r.r2, 1: r.r1 } },
      people: people[0],
      designs,
    });
  } catch (err) {
    console.error('GET /api/dashboard failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch dashboard' });
  }
});

module.exports = router;
