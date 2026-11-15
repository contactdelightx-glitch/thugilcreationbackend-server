const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireUser } = require('../auth');
const { zipSync } = require('fflate');
const { razorpayKeys, razorpayCreateOrder } = require('../razorpay');

const router = Router();

const TABLES = {
  butta: 'butta_designs', pattern: 'pattern_designs', full_set: 'full_set_designs', brocade: 'brocade_designs',
  pallu: 'pallu_designs', border: 'border_designs', free_image: 'free_image_designs',
};
const MAX_ITEMS = 50;
/**
 * @openapi
 * /api/store/checkout:
 *   post:
 *     tags: [Store]
 *     summary: Start a payment for the designs in the cart (prices come from the database, not the browser)
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [items]
 *             properties:
 *               items: { type: array, items: { type: object, properties: { category: { type: string }, id: { type: integer } } } }
 *     responses:
 *       200: { description: "{ orderId, amount (paise), currency, keyId, total }" }
 *       400: { description: Empty cart, unknown design or nothing to pay }
 *       401: { description: Not logged in }
 *       409: { description: Some designs were already bought }
 */
router.post('/api/store/checkout', requireUser, async (req, res) => {
  const wanted = Array.isArray(req.body?.items) ? req.body.items : [];
  const seen = new Set();
  const list = [];
  for (const it of wanted) {
    const category = String(it?.category);
    const id = Number(it?.id);
    if (!TABLES[category] || !Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'A design in the cart is not valid' });
    if (!seen.has(`${category}:${id}`)) { seen.add(`${category}:${id}`); list.push({ category, id }); }
  }
  if (list.length === 0) return res.status(400).json({ error: 'Your cart is empty' });
  if (list.length > MAX_ITEMS) return res.status(400).json({ error: `At most ${MAX_ITEMS} designs can be bought at once` });

  try {
    // price and name are read here, so nobody can pay less by editing the cart in the browser
    const items = [];
    for (const { category, id } of list) {
      const nameCol = category === 'free_image' ? 'NULL::varchar' : 'name';
      const { rows } = await pool.query(
        `SELECT id, ${nameCol} AS name, split_part(btrim(image_url), ' ', 1) AS image_url, listing_rate::float AS listing_rate, final_price::float AS final_price FROM ${TABLES[category]} WHERE id = $1`, [id]
      );
      if (!rows[0]) return res.status(400).json({ error: 'A design in the cart is no longer available. Please remove it and try again.' });
      items.push({ category, design_id: id, name: rows[0].name || 'Free design', image_url: rows[0].image_url, price: rows[0].listing_rate, final_price: rows[0].final_price });
    }

    // a design is bought once
    const owned = await pool.query(
      `SELECT i.design_category AS category, i.design_id AS id FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE o.customer_id = $1 AND o.payment_status = 'captured'`, [req.customerId]
    );
    const have = new Set(owned.rows.map((r) => `${r.category}:${r.id}`));
    const dup = items.filter((i) => have.has(`${i.category}:${i.design_id}`));
    if (dup.length) return res.status(409).json({ error: `You already bought ${dup.map((d) => d.name).join(', ')}. Remove ${dup.length === 1 ? 'it' : 'them'} from the cart.`, already: dup.map((d) => ({ category: d.category, id: d.design_id })) });

    const amountPaise = Math.round(items.reduce((n, i) => n + i.final_price, 0) * 100);
    if (amountPaise < 100) return res.status(400).json({ error: 'The total must be at least ₹1 to pay online' });

    const order = await razorpayCreateOrder({ amountPaise, receipt: `c${req.customerId}-${Date.now()}` });
    await pool.query(
      'INSERT INTO checkout_sessions (razorpay_order_id, customer_id, amount, items) VALUES ($1, $2, $3, $4)',
      [order.id, req.customerId, amountPaise / 100, JSON.stringify(items)]
    );
    res.json({ orderId: order.id, amount: amountPaise, currency: 'INR', keyId: razorpayKeys().id, total: amountPaise / 100 });
  } catch (err) {
    console.error('POST /api/store/checkout failed:', err.message);
    res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
  }
});

/**
 * @openapi
 * /api/store/checkout/verify:
 *   post:
 *     tags: [Store]
 *     summary: Confirm a Razorpay payment (checks its signature) and save the order
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [razorpay_order_id, razorpay_payment_id, razorpay_signature]
 *             properties: { razorpay_order_id: { type: string }, razorpay_payment_id: { type: string }, razorpay_signature: { type: string } }
 *     responses:
 *       200: { description: "{ orderId, total, items }" }
 *       400: { description: Signature does not match }
 *       404: { description: No such checkout for this shopper }
 */
router.post('/api/store/checkout/verify', requireUser, async (req, res) => {
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'The payment details are incomplete' });

  let keys;
  try { keys = razorpayKeys(); } catch (err) { console.error(err.message); return res.status(500).json({ error: 'Payments are not configured on the server' }); }

  // Razorpay signs "order_id|payment_id" with the key secret; only a real payment has a matching signature
  const expected = Buffer.from(crypto.createHmac('sha256', keys.secret).update(`${orderId}|${paymentId}`).digest('hex'));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
    return res.status(400).json({ error: 'The payment could not be verified. If money was taken, please contact us with your payment id.' });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // the same payment confirmed twice (double click, retry) returns the same order
    const done = await client.query('SELECT id, total::float AS total FROM orders WHERE razorpay_payment_id = $1 AND customer_id = $2', [paymentId, req.customerId]);
    if (done.rows[0]) { await client.query('COMMIT'); return res.json({ orderId: done.rows[0].id, total: done.rows[0].total, already: true }); }

    const found = await client.query('SELECT amount::float AS amount, items FROM checkout_sessions WHERE razorpay_order_id = $1 AND customer_id = $2 FOR UPDATE', [orderId, req.customerId]);
    const session = found.rows[0];
    if (!session || !Array.isArray(session.items)) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No payment is waiting for this account' }); }

    const user = (await client.query('SELECT phone FROM users WHERE customer_id = $1', [req.customerId])).rows[0];
    const order = (await client.query(
      `INSERT INTO orders (customer_id, mobile_number, items_total, platform_fee, total, payment_status, razorpay_order_id, razorpay_payment_id, razorpay_signature)
       VALUES ($1, $2, $3, 0, $3, 'captured', $4, $5, $6) RETURNING id`,
      [req.customerId, (user && user.phone) || 'not given', session.amount, orderId, paymentId, signature]
    )).rows[0];
    for (const [i, it] of session.items.entries()) {
      await client.query(
        `INSERT INTO order_items (order_id, position, design_id, design_category, design_name, image_url, price, final_price) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [order.id, i + 1, it.design_id, it.category, it.name, it.image_url, it.price, it.final_price]
      );
    }
    await client.query('DELETE FROM checkout_sessions WHERE razorpay_order_id = $1', [orderId]);
    await client.query('COMMIT');
    res.json({ orderId: order.id, total: session.amount, items: session.items.length });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/store/checkout/verify failed:', err.message);
    res.status(500).json({ error: 'Your payment went through but we could not save the order. Please contact us with your payment id.' });
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/store/orders/{id}:
 *   get:
 *     tags: [Store]
 *     summary: One of the logged-in shopper's own orders, with its designs (for the purchase-complete page)
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ id, total, created_at, payment_id, items: [{ name, category, image_url, final_price }] }" }
 *       401: { description: Not logged in }
 *       404: { description: Not found, or not this shopper's order }
 */
router.get('/api/store/orders/:id', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Order not found' });
  try {
    const order = await pool.query(
      `SELECT id, total::float AS total, payment_status, razorpay_payment_id AS payment_id, created_at
         FROM orders WHERE id = $1 AND customer_id = $2`, [id, req.customerId]
    );
    if (!order.rowCount) return res.status(404).json({ error: 'Order not found' });
    const items = await pool.query(
      `SELECT design_name AS name, design_category AS category, split_part(btrim(image_url), ' ', 1) AS image_url, final_price::float AS final_price
         FROM order_items WHERE order_id = $1 ORDER BY position`, [id]
    );
    res.json({ ...order.rows[0], items: items.rows });
  } catch (err) {
    console.error('GET /api/store/orders/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to load the order' });
  }
});

/**
 * The rows a shopper has bought, each with the design's ORIGINAL image (the full file, not the blurred preview).
 * Falls back to the preview stored on the order when the design is gone or has no original.
 */
async function boughtItems(customerId, onlyItemId) {
  const params = [customerId];
  let extra = '';
  if (onlyItemId) { params.push(onlyItemId); extra = 'AND i.id = $2'; }
  const { rows } = await pool.query(
    `SELECT i.id AS item_id, i.design_id, i.design_category AS category, i.design_name AS name, split_part(btrim(i.image_url), ' ', 1) AS preview_url,
            o.id AS order_id, o.created_at AS purchased_at, rv.rating AS my_rating, rv.review AS my_review
       FROM order_items i JOIN orders o ON o.id = i.order_id
       LEFT JOIN saree_ratings rv ON rv.customer_id = o.customer_id AND rv.design_category = i.design_category AND rv.design_id = i.design_id
      WHERE o.customer_id = $1 AND o.payment_status = 'captured' ${extra}
      ORDER BY o.created_at DESC, o.id DESC, i.position
      LIMIT 500`, params
  );
  const byCategory = {};
  for (const r of rows) if (r.category && TABLES[r.category] && r.design_id) (byCategory[r.category] ||= new Set()).add(String(r.design_id));
  const originals = {};
  for (const [category, ids] of Object.entries(byCategory)) {
    const found = await pool.query(`SELECT id, original_image_url FROM ${TABLES[category]} WHERE id = ANY($1::bigint[])`, [[...ids]]);
    for (const d of found.rows) originals[`${category}:${d.id}`] = d.original_image_url;
  }
  // a design can have several original files (a Full Set keeps all its parts in one field, separated by spaces)
  return rows.map(({ design_id, preview_url, ...r }) => {
    const files = String(originals[`${r.category}:${design_id}`] || '').trim().split(/\s+/).filter(Boolean);
    return { ...r, original_files: files.length ? files : [preview_url] };
  });
}

/**
 * @openapi
 * /api/store/purchases:
 *   get:
 *     tags: [Store]
 *     summary: The designs the logged-in shopper has bought, newest first, each with its original image
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ data: [{ item_id, name, category, image_url (the original), order_id, purchased_at }] }" }
 *       401: { description: Not logged in }
 */
router.get('/api/store/purchases', requireUser, async (req, res) => {
  try {
    const rows = await boughtItems(req.customerId);
    res.json({ data: rows.map(({ original_files, ...r }) => ({ ...r, image_url: original_files[0], files: original_files.length })) });
  } catch (err) {
    console.error('GET /api/store/purchases failed:', err.message);
    res.status(500).json({ error: 'Failed to load your purchases' });
  }
});

/**
 * @openapi
 * /api/store/purchases/{itemId}/download:
 *   get:
 *     tags: [Store]
 *     summary: Download the original design file of something the logged-in shopper has bought
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: itemId, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The file, as an attachment }
 *       401: { description: Not logged in }
 *       404: { description: Not bought by this shopper }
 */
router.get('/api/store/purchases/:itemId/download', requireUser, async (req, res) => {
  const itemId = Number(req.params.itemId);
  if (!Number.isInteger(itemId) || itemId < 1) return res.status(404).json({ error: 'Not found' });
  try {
    const [item] = await boughtItems(req.customerId, itemId);
    if (!item) return res.status(404).json({ error: 'You have not bought this design' });
    const safe = String(item.name || 'design').replace(/[^A-Za-z0-9._-]+/g, '_');
    const extOf = (u) => (new URL(u).pathname.match(/\.([a-z0-9]{2,5})$/i) || [, 'bmp'])[1].toLowerCase();
    res.setHeader('Cache-Control', 'private, no-store');
    if (item.original_files.length === 1) {
      const file = await fetch(item.original_files[0]);
      if (!file.ok) return res.status(502).json({ error: 'The design file could not be fetched. Please try again.' });
      res.setHeader('Content-Type', file.headers.get('content-type') || 'application/octet-stream');
      res.setHeader('Content-Disposition', `attachment; filename="${safe}.${extOf(item.original_files[0])}"`);
      return res.send(Buffer.from(await file.arrayBuffer()));
    }
    // several files: one zip, the files numbered in order
    const entries = {};
    for (const [n, url] of item.original_files.entries()) {
      const file = await fetch(url);
      if (!file.ok) return res.status(502).json({ error: 'A design file could not be fetched. Please try again.' });
      entries[`${safe}-${n + 1}.${extOf(url)}`] = new Uint8Array(await file.arrayBuffer());
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${safe}.zip"`);
    res.send(Buffer.from(zipSync(entries, { level: 6 })));
  } catch (err) {
    console.error('GET /api/store/purchases/:itemId/download failed:', err.message);
    res.status(500).json({ error: 'Download failed. Please try again.' });
  }
});

/**
 * @openapi
 * /api/store/purchases/{itemId}/review:
 *   put:
 *     tags: [Store]
 *     summary: Write (or change) your review of a design you bought
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: itemId, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [rating]
 *             properties: { rating: { type: integer, minimum: 1, maximum: 5 }, review: { type: string, maxLength: 1000 } }
 *     responses:
 *       200: { description: "{ rating, review }" }
 *       400: { description: Invalid rating or review }
 *       401: { description: Not logged in }
 *       404: { description: Not bought by this shopper }
 */
router.put('/api/store/purchases/:itemId/review', requireUser, async (req, res) => {
  const itemId = Number(req.params.itemId);
  const rating = Number(req.body?.rating);
  const review = String(req.body?.review ?? '').trim();
  if (!Number.isInteger(itemId) || itemId < 1) return res.status(404).json({ error: 'Not found' });
  if (!Number.isInteger(rating) || rating < 1 || rating > 5) return res.status(400).json({ error: 'Choose 1 to 5 stars' });
  if (review.length > 1000) return res.status(400).json({ error: 'The review can be at most 1000 characters' });
  try {
    const item = (await pool.query(
      `SELECT i.design_id, i.design_category FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.id = $1 AND o.customer_id = $2 AND o.payment_status = 'captured'`, [itemId, req.customerId]
    )).rows[0];
    if (!item) return res.status(404).json({ error: 'You can only review designs you have bought' });
    if (!item.design_id || !item.design_category) return res.status(400).json({ error: 'This design can no longer be reviewed' });
    const saved = (await pool.query(
      `INSERT INTO saree_ratings (design_id, design_category, rating, review, customer_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (customer_id, design_category, design_id) WHERE customer_id IS NOT NULL AND design_id IS NOT NULL
       DO UPDATE SET rating = EXCLUDED.rating, review = EXCLUDED.review, updated_at = NOW()
       RETURNING rating, review`,
      [item.design_id, item.design_category, rating, review || null, req.customerId]
    )).rows[0];
    res.json(saved);
  } catch (err) {
    console.error('PUT /api/store/purchases/:itemId/review failed:', err.message);
    res.status(500).json({ error: 'Could not save your review. Please try again.' });
  }
});

module.exports = router;
