const { Router } = require('express');
const pool = require('../db');
const { monthTrends } = require('../monthTrends');

const router = Router();
const STATUSES = ['pending', 'captured', 'failed', 'refunded'];

// razorpay_signature is deliberately never returned
const ORDER_COLUMNS = `o.id, o.customer_id, o.mobile_number, u.full_name AS customer_name, u.email AS customer_email,
  o.items_total, o.platform_fee, o.total, o.currency, o.payment_status,
  o.razorpay_order_id, o.razorpay_payment_id, o.email_sent, o.created_at,
  (SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)::int AS item_count`;

/**
 * @openapi
 * /api/orders/summary:
 *   get:
 *     tags: [Orders]
 *     summary: Order totals (captured payments only count as revenue)
 *     responses:
 *       200: { description: "{ orders, captured, revenue, fees, itemsSold }" }
 */
router.get('/api/orders/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT COUNT(*)::int AS orders,
              COUNT(*) FILTER (WHERE payment_status = 'captured')::int AS captured,
              COALESCE(SUM(total) FILTER (WHERE payment_status = 'captured'), 0)::float AS revenue,
              COALESCE(SUM(platform_fee) FILTER (WHERE payment_status = 'captured'), 0)::float AS fees,
              (SELECT COUNT(*) FROM order_items i JOIN orders o2 ON o2.id = i.order_id WHERE o2.payment_status = 'captured')::int AS "itemsSold"
         FROM orders`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/orders/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch order summary' });
  }
});

// ---------- month trends for the KPI cards (shared logic in ../monthTrends) ----------
/**
 * @openapi
 * /api/orders/trends:
 *   get:
 *     tags: [Orders]
 *     summary: Month-so-far trend of revenue, orders, designs sold and average order, against the month before
 *     description: >
 *       Cumulative day-by-day series for the chosen month and for the month before it, so growth or loss is visible.
 *       For the current month only the days up to today are returned for "current", and "previousToDate" is the
 *       previous month's value on the same day, so the comparison is like for like. Only captured payments count.
 *     parameters:
 *       - { in: query, name: month, schema: { type: string, example: "2026-11" }, description: Defaults to the current month }
 *     responses:
 *       200: { description: Series and totals per metric }
 *       400: { description: Invalid month }
 */
router.get('/api/orders/trends', async (req, res) => {
  try {
    const { status, body } = await monthTrends(pool, {
      month: req.query.month,
      metrics: ['revenue', 'orders', 'items'],
      avg: { sum: 'revenue', count: 'orders' },
      rowsSql: `SELECT to_char(o.created_at AT TIME ZONE $1, 'YYYY-MM') AS month,
                       EXTRACT(DAY FROM o.created_at AT TIME ZONE $1)::int AS day,
                       COUNT(*)::int AS orders,
                       COALESCE(SUM(o.total), 0)::float AS revenue,
                       COALESCE(SUM((SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)), 0)::int AS items
                  FROM orders o
                 WHERE o.payment_status = 'captured'
                   AND (o.created_at AT TIME ZONE $1) >= $2::date AND (o.created_at AT TIME ZONE $1) < $3::date
                 GROUP BY 1, 2`,
      firstSql: `SELECT to_char(MIN(created_at) AT TIME ZONE $1, 'YYYY-MM') AS m FROM orders WHERE payment_status = 'captured'`,
    });
    res.status(status).json(body);
  } catch (err) {
    console.error('GET /api/orders/trends failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch trends' });
  }
});

/**
 * @openapi
 * /api/orders:
 *   get:
 *     tags: [Orders]
 *     summary: List orders, newest first
 *     parameters:
 *       - { in: query, name: search, schema: { type: string }, description: Matches order number, mobile, customer name or email, or Razorpay ids }
 *       - { in: query, name: status, schema: { type: string, enum: [all, pending, captured, failed, refunded], default: all } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position (infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 30, maximum: 100 } }
 *     responses:
 *       200: { description: A page of orders }
 */
router.get('/api/orders', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const search = String(req.query.search || '').trim();

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    const p = `$${params.length}`;
    where.push(`(o.id::text ILIKE ${p} OR o.mobile_number ILIKE ${p} OR u.email ILIKE ${p} OR u.full_name ILIKE ${p}
                 OR o.razorpay_payment_id ILIKE ${p} OR o.razorpay_order_id ILIKE ${p})`);
  }
  if (STATUSES.includes(req.query.status)) {
    params.push(req.query.status);
    where.push(`o.payment_status = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const from = 'FROM orders o LEFT JOIN users u ON u.customer_id = o.customer_id';

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n ${from} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT ${ORDER_COLUMNS} ${from} ${clause}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, offset, limit, total, hasMore: offset + rows.length < total });
  } catch (err) {
    console.error('GET /api/orders failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch orders' });
  }
});

/**
 * @openapi
 * /api/orders/{id}/items:
 *   get:
 *     tags: [Orders]
 *     summary: The designs bought in one order
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The order's items, in the order they were added }
 *       404: { description: Order not found }
 */
router.get('/api/orders/:id/items', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid order id' });
  try {
    const order = await pool.query('SELECT 1 FROM orders WHERE id = $1', [id]);
    if (!order.rowCount) return res.status(404).json({ error: 'Order not found' });
    const { rows } = await pool.query(
      `SELECT id, position, design_id, design_category, design_name, image_url, price, final_price
         FROM order_items WHERE order_id = $1 ORDER BY position`,
      [id]
    );
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/orders/:id/items failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch order items' });
  }
});

module.exports = router;
