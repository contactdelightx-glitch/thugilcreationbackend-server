const { Router } = require('express');
const crypto = require('crypto');
const pool = require('../db');
const { requireUser } = require('../auth');

const router = Router();

const TABLES = {
  butta: 'butta_designs', pattern: 'pattern_designs', full_set: 'full_set_designs', brocade: 'brocade_designs',
  pallu: 'pallu_designs', border: 'border_designs', free_image: 'free_image_designs',
};
const MAX_ITEMS = 50;
const razorpayBase = () => process.env.RAZORPAY_API_BASE || 'https://api.razorpay.com';

function razorpayKeys() {
  const id = process.env.RAZORPAY_KEY_ID;
  const secret = process.env.RAZORPAY_KEY_SECRET;
  if (!id || !secret) throw new Error('Razorpay keys are not set (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET)');
  return { id, secret };
}

async function razorpayCreateOrder({ amountPaise, receipt }) {
  const { id, secret } = razorpayKeys();
  const res = await fetch(`${razorpayBase()}/v1/orders`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}` },
    body: JSON.stringify({ amount: amountPaise, currency: 'INR', receipt }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Razorpay refused the order (${res.status}): ${body?.error?.description || 'no details'}`);
  return body;
}

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
        `SELECT id, ${nameCol} AS name, image_url, listing_rate::float AS listing_rate, final_price::float AS final_price FROM ${TABLES[category]} WHERE id = $1`, [id]
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
    if (!session) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No payment is waiting for this account' }); }

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

module.exports = router;
