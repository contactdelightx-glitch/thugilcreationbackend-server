const { Router } = require('express');
const pool = require('../db');
const notify = require('../notify');
const { requireUser } = require('../auth');
const { razorpayKeys, razorpayCreateOrder, verifyPaymentSignature } = require('../razorpay');

const router = Router();

// what a shopper sees of a package
const PUBLIC = `id, name, description, details, price::float AS price, cost_percent, delivery_days, validity_days, max_requests, is_popular`;

/** the customer's package that has not run out yet (the latest one), with how many works it has been used for */
async function activeSubscription(customerId, db = pool) {
  const { rows } = await db.query(
    `SELECT s.id, s.package_id, s.package_name, s.price_paid::float AS price_paid, s.cost_percent, s.delivery_days, s.max_requests, s.starts_at, s.expires_at,
            (SELECT COUNT(*)::int FROM design_requests r WHERE r.subscription_id = s.id) AS used
       FROM design_subscriptions s WHERE s.customer_id = $1 AND s.expires_at > NOW() ORDER BY s.expires_at DESC LIMIT 1`, [customerId]);
  return rows[0] || null;
}

// ------------------------------------------------------------------ shoppers

/**
 * @openapi
 * /api/store/design-packages:
 *   get:
 *     tags: [Design packages]
 *     summary: The packages a customer can subscribe to before sending work to the designer
 *     responses:
 *       200: { description: "{ data: [{ id, name, description, details, price, cost_percent, delivery_days, validity_days, max_requests }] }" }
 */
router.get('/api/store/design-packages', async (req, res) => {
  try {
    const { rows } = await pool.query(`SELECT ${PUBLIC} FROM design_packages WHERE is_active ORDER BY position, price, id`);
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/store/design-packages failed:', err.message);
    res.status(500).json({ error: 'Failed to load the packages' });
  }
});

/**
 * @openapi
 * /api/store/design-subscription:
 *   get:
 *     tags: [Design packages]
 *     summary: The logged-in customer's current package (null when they have none, or it has run out)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: "{ subscription: null | { id, package_name, cost_percent, delivery_days, max_requests, used, expires_at, days_left } }" }
 */
router.get('/api/store/design-subscription', requireUser, async (req, res) => {
  try {
    const s = await activeSubscription(req.customerId);
    res.json({ subscription: s && { ...s, days_left: Math.max(0, Math.round((new Date(s.expires_at) - Date.now()) / 86400000)) } });
  } catch (err) {
    console.error('GET /api/store/design-subscription failed:', err.message);
    res.status(500).json({ error: 'Failed to load your package' });
  }
});

async function createSubscription(db, customerId, pkg, { paid, orderId, paymentId }) {
  return (await db.query(
    `INSERT INTO design_subscriptions (customer_id, package_id, package_name, price_paid, cost_percent, delivery_days, max_requests, razorpay_order_id, razorpay_payment_id, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW() + make_interval(days => $10::int)) RETURNING id, expires_at`,
    [customerId, pkg.id, pkg.name, paid, pkg.cost_percent, pkg.delivery_days, pkg.max_requests, orderId || null, paymentId || null, pkg.validity_days])).rows[0];
}

/**
 * @openapi
 * /api/store/design-packages/{id}/checkout:
 *   post:
 *     tags: [Design packages]
 *     summary: Start paying for a package (Razorpay). A free package is activated straight away
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ orderId, amount (paise), currency, keyId, total, package } or { free: true } when there is nothing to pay" }
 *       404: { description: Package not available }
 *       409: { description: The customer already has a package }
 */
router.post('/api/store/design-packages/:id/checkout', requireUser, async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'This package is not available' });
  try {
    const pkg = (await pool.query('SELECT * FROM design_packages WHERE id = $1 AND is_active', [id])).rows[0];
    if (!pkg) return res.status(404).json({ error: 'This package is not available' });
    if (await activeSubscription(req.customerId)) return res.status(409).json({ error: 'You already have a package. You can choose another one when it ends.' });
    const price = Number(pkg.price);
    if (price === 0) {
      await createSubscription(pool, req.customerId, pkg, { paid: 0 });
      return res.json({ free: true, package: pkg.name });
    }
    if (price < 1) return res.status(400).json({ error: 'This package has no price to pay online' });
    const amountPaise = Math.round(price * 100);
    const order = await razorpayCreateOrder({ amountPaise, receipt: `p${req.customerId}-${id}-${Date.now()}` });
    await pool.query('INSERT INTO checkout_sessions (razorpay_order_id, customer_id, amount, items) VALUES ($1, $2, $3, $4)',
      [order.id, req.customerId, price, JSON.stringify({ kind: 'design_package', package_id: id })]);
    res.json({ orderId: order.id, amount: amountPaise, currency: 'INR', keyId: razorpayKeys().id, total: price, package: pkg.name });
  } catch (err) {
    console.error('POST /api/store/design-packages/:id/checkout failed:', err.message);
    res.status(502).json({ error: 'Could not start the payment. Please try again in a moment.' });
  }
});

/**
 * @openapi
 * /api/store/design-packages/checkout/verify:
 *   post:
 *     tags: [Design packages]
 *     summary: Confirm a package payment (checks Razorpay's signature) and start the package
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [razorpay_order_id, razorpay_payment_id, razorpay_signature], properties: { razorpay_order_id: { type: string }, razorpay_payment_id: { type: string }, razorpay_signature: { type: string } } }
 *     responses:
 *       200: { description: "{ subscriptionId, expires_at }" }
 *       400: { description: Signature does not match }
 *       404: { description: No package payment is waiting for this account }
 */
router.post('/api/store/design-packages/checkout/verify', requireUser, async (req, res) => {
  const orderId = String(req.body?.razorpay_order_id || '');
  const paymentId = String(req.body?.razorpay_payment_id || '');
  const signature = String(req.body?.razorpay_signature || '');
  if (!orderId || !paymentId || !signature) return res.status(400).json({ error: 'The payment details are incomplete' });
  try { if (!verifyPaymentSignature(orderId, paymentId, signature)) return res.status(400).json({ error: 'The payment could not be verified. If money was taken, please contact us with your payment id.' }); }
  catch (err) { console.error(err.message); return res.status(500).json({ error: 'Payments are not configured on the server' }); }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const done = (await client.query('SELECT id, expires_at FROM design_subscriptions WHERE razorpay_payment_id = $1 AND customer_id = $2', [paymentId, req.customerId])).rows[0];
    if (done) { await client.query('COMMIT'); return res.json({ subscriptionId: done.id, expires_at: done.expires_at, already: true }); }
    const s = (await client.query('SELECT amount::float AS amount, items FROM checkout_sessions WHERE razorpay_order_id = $1 AND customer_id = $2 FOR UPDATE', [orderId, req.customerId])).rows[0];
    if (!s || Array.isArray(s.items) || s.items?.kind !== 'design_package') { await client.query('ROLLBACK'); return res.status(404).json({ error: 'No package payment is waiting for this account' }); }
    const pkg = (await client.query('SELECT * FROM design_packages WHERE id = $1', [s.items.package_id])).rows[0];
    if (!pkg) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'This package is no longer available. Please contact us with your payment id.' }); }
    const sub = await createSubscription(client, req.customerId, pkg, { paid: s.amount, orderId, paymentId });
    await client.query('DELETE FROM checkout_sessions WHERE razorpay_order_id = $1', [orderId]);
    await client.query('COMMIT');
    notify.designPackageBought({ customerId: req.customerId, subscriptionId: sub.id, paymentId });
    res.json({ subscriptionId: sub.id, expires_at: sub.expires_at });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('POST /api/store/design-packages/checkout/verify failed:', err.message);
    res.status(500).json({ error: 'Your payment went through but we could not start your package. Please contact us with your payment id.' });
  } finally {
    client.release();
  }
});

// -------------------------------------------------------------------- admin

const text = (v) => (v == null ? '' : String(v).trim());
const intIn = (v, min, max) => { const n = Number(v); return Number.isInteger(n) && n >= min && n <= max ? n : null; };

/** checks a package sent by the admin; `partial` (an edit) only checks what was sent */
function checkPackage(b, partial) {
  const f = {}; const out = {};
  const has = (k) => b[k] !== undefined;
  if (!partial || has('name')) { const v = text(b.name); if (!v || v.length > 80) f.name = 'needs a name of up to 80 characters'; else out.name = v; }
  if (!partial || has('description')) { const v = text(b.description); if (v.length > 200) f.description = 'must be at most 200 characters'; else out.description = v || null; }
  if (!partial || has('details')) { const v = text(b.details); if (v.length > 2000) f.details = 'must be at most 2000 characters'; else out.details = v || null; }
  if (!partial || has('price')) { const n = Number(b.price); if (b.price === '' || b.price == null || !Number.isFinite(n) || n < 0 || n > 10000000) f.price = 'must be 0 or more'; else out.price = Math.round(n * 100) / 100; }
  if (!partial || has('cost_percent')) { const n = intIn(b.cost_percent, 1, 100); if (n === null) f.cost_percent = 'must be a whole number from 1 to 100'; else out.cost_percent = n; }
  if (!partial || has('delivery_days')) { const n = intIn(b.delivery_days, 1, 365); if (n === null) f.delivery_days = 'must be a whole number of days from 1 to 365'; else out.delivery_days = n; }
  if (!partial || has('validity_days')) { const n = intIn(b.validity_days ?? 30, 1, 3650); if (n === null) f.validity_days = 'must be a whole number of days from 1 to 3650'; else out.validity_days = n; }
  if (has('max_requests')) {
    if (b.max_requests === null || b.max_requests === '') out.max_requests = null;
    else { const n = intIn(b.max_requests, 1, 10000); if (n === null) f.max_requests = 'must be a whole number, or empty for no limit'; else out.max_requests = n; }
  } else if (!partial) out.max_requests = null;
  if (has('is_active')) out.is_active = Boolean(b.is_active);
  if (has('is_popular')) out.is_popular = Boolean(b.is_popular);
  if (has('position')) { const n = intIn(b.position, 0, 100000); if (n === null) f.position = 'must be a whole number'; else out.position = n; }
  return { f, out };
}

const ADMIN_SELECT = `SELECT p.id, p.name, p.description, p.details, p.price::float AS price, p.cost_percent, p.delivery_days, p.validity_days, p.max_requests, p.is_active, p.is_popular, p.position, p.created_at,
                             (SELECT COUNT(*)::int FROM design_subscriptions s WHERE s.package_id = p.id) AS subscribers,
                             (SELECT COUNT(*)::int FROM design_subscriptions s WHERE s.package_id = p.id AND s.expires_at > NOW()) AS active_subscribers
                        FROM design_packages p`;

/**
 * @openapi
 * /api/design-packages:
 *   get:
 *     tags: [Design packages]
 *     summary: All packages (also the switched-off ones), with how many customers bought each
 *     responses:
 *       200: { description: "{ data: [...] }" }
 *   post:
 *     tags: [Design packages]
 *     summary: Add a package
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [name, price, cost_percent, delivery_days], properties: { name: { type: string }, description: { type: string }, details: { type: string }, price: { type: number }, cost_percent: { type: integer, minimum: 1, maximum: 100 }, delivery_days: { type: integer }, validity_days: { type: integer }, max_requests: { type: integer, nullable: true }, is_active: { type: boolean }, position: { type: integer } } }
 *     responses:
 *       201: { description: The package }
 *       400: { description: Invalid details }
 */
router.get('/api/design-packages', async (req, res) => {
  try {
    res.json({ data: (await pool.query(`${ADMIN_SELECT} ORDER BY p.position, p.price, p.id`)).rows });
  } catch (err) {
    console.error('GET /api/design-packages failed:', err.message);
    res.status(500).json({ error: 'Failed to load the packages' });
  }
});

router.post('/api/design-packages', async (req, res) => {
  const { f, out } = checkPackage(req.body || {}, false);
  if (Object.keys(f).length) return res.status(400).json({ error: `${Object.keys(f)[0].replace(/_/g, ' ')} ${Object.values(f)[0]}`, fields: f });
  try {
    const pos = out.position ?? (await pool.query('SELECT COALESCE(MAX(position), 0) + 1 AS p FROM design_packages')).rows[0].p;
    const { rows } = await pool.query(
      `INSERT INTO design_packages (name, description, details, price, cost_percent, delivery_days, validity_days, max_requests, is_active, is_popular, position)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [out.name, out.description, out.details, out.price, out.cost_percent, out.delivery_days, out.validity_days, out.max_requests, out.is_active ?? true, out.is_popular ?? false, pos]);
    res.status(201).json((await pool.query(`${ADMIN_SELECT} WHERE p.id = $1`, [rows[0].id])).rows[0]);
  } catch (err) {
    console.error('POST /api/design-packages failed:', err.message);
    res.status(500).json({ error: 'Could not save the package' });
  }
});

/**
 * @openapi
 * /api/design-packages/{id}:
 *   patch:
 *     tags: [Design packages]
 *     summary: Change a package. Customers who already bought it keep the terms they paid for
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The package }
 *       400: { description: Invalid details }
 *       404: { description: Not found }
 *   delete:
 *     tags: [Design packages]
 *     summary: Delete a package nobody has bought. A bought one can only be switched off
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       409: { description: Customers have bought it }
 */
router.patch('/api/design-packages/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Package not found' });
  const { f, out } = checkPackage(req.body || {}, true);
  if (Object.keys(f).length) return res.status(400).json({ error: `${Object.keys(f)[0].replace(/_/g, ' ')} ${Object.values(f)[0]}`, fields: f });
  const keys = Object.keys(out);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to change' });
  try {
    const sets = keys.map((k, i) => `${k} = $${i + 1}`);
    const { rowCount } = await pool.query(`UPDATE design_packages SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${keys.length + 1}`, [...keys.map((k) => out[k]), id]);
    if (!rowCount) return res.status(404).json({ error: 'Package not found' });
    res.json((await pool.query(`${ADMIN_SELECT} WHERE p.id = $1`, [id])).rows[0]);
  } catch (err) {
    console.error('PATCH /api/design-packages/:id failed:', err.message);
    res.status(500).json({ error: 'Could not save the package' });
  }
});

router.delete('/api/design-packages/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Package not found' });
  try {
    const bought = (await pool.query('SELECT 1 FROM design_subscriptions WHERE package_id = $1 LIMIT 1', [id])).rows[0];
    if (bought) return res.status(409).json({ error: 'Customers have bought this package, so it cannot be deleted. Switch it off instead.' });
    const { rowCount } = await pool.query('DELETE FROM design_packages WHERE id = $1', [id]);
    if (!rowCount) return res.status(404).json({ error: 'Package not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/design-packages/:id failed:', err.message);
    res.status(500).json({ error: 'Could not delete the package' });
  }
});

/**
 * @openapi
 * /api/design-subscriptions:
 *   get:
 *     tags: [Design packages]
 *     summary: The customers who bought a package, latest first, with how many works each has sent
 *     parameters:
 *       - { in: query, name: limit, schema: { type: integer, default: 50, maximum: 200 } }
 *     responses:
 *       200: { description: "{ data: [...] }" }
 */
router.get('/api/design-subscriptions', async (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
  try {
    const { rows } = await pool.query(
      `SELECT s.id, s.package_name, s.price_paid::float AS price_paid, s.cost_percent, s.delivery_days, s.max_requests, s.starts_at, s.expires_at,
              (s.expires_at > NOW()) AS active, u.full_name, u.email, u.phone,
              (SELECT COUNT(*)::int FROM design_requests r WHERE r.subscription_id = s.id) AS used
         FROM design_subscriptions s LEFT JOIN users u ON u.customer_id = s.customer_id ORDER BY s.created_at DESC LIMIT $1`, [limit]);
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/design-subscriptions failed:', err.message);
    res.status(500).json({ error: 'Failed to load the subscribers' });
  }
});

module.exports = router;
module.exports.activeSubscription = activeSubscription;
