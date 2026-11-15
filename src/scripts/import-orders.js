/**
 * One-off import: Supabase public.orders -> local orders + order_items.
 *
 * Supabase is READ-ONLY here: only GET requests are made.
 * Safe to re-run: orders whose id already exists are skipped (and so are their items).
 *
 *   node src/scripts/import-orders.js            # dry run (nothing written)
 *   node src/scripts/import-orders.js --commit   # write to the local DB
 *
 * Cleaning rules
 *  - amounts are rupees: total = final_price; the old total_amount was a mix of paise and rupees, so it is dropped
 *  - platform_fee = final_price - sum(item final_price)   (0 or 2 in the data)
 *  - payment_status is trimmed ("captured " -> "captured")
 *  - the old payment_id duplicated razorpay_payment_id; it is used when razorpay_payment_id is missing
 *  - customer_id is found from the mobile number; items are matched to a design by id (category recorded)
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');
const CATEGORIES = ['butta', 'brocade', 'border', 'pallu', 'pattern', 'full_set', 'free_image'];
const money = (n) => Math.round(Number(n) * 100) / 100;

async function fetchOrders() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/orders?select=*&order=order_id.asc`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(JSON.stringify(body));
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

async function loadLookups() {
  // mobile -> customer ids
  const byPhone = new Map();
  for (const u of (await pool.query('SELECT customer_id, phone FROM users WHERE phone IS NOT NULL ORDER BY customer_id')).rows) {
    byPhone.set(u.phone, [...(byPhone.get(u.phone) || []), u.customer_id]);
  }
  // design id -> categories it exists in
  const designs = new Map();
  for (const c of CATEGORIES) {
    for (const r of (await pool.query(`SELECT id FROM ${c}_designs`)).rows) {
      designs.set(String(r.id), [...(designs.get(String(r.id)) || []), c]);
    }
  }
  return { byPhone, designs };
}

function build(source, { byPhone, designs }) {
  const orders = [];
  const rejected = [];
  const stats = { statusTrimmed: 0, paymentIdFilled: 0, ambiguousCustomer: 0, noCustomer: 0, itemsUnmatchedDesign: 0, itemsAmbiguousDesign: 0, feeValues: {} };

  for (const o of source) {
    const fail = (reason) => rejected.push({ order_id: o.order_id, reason });
    if (!Array.isArray(o.items) || o.items.length === 0) { fail('no items'); continue; }

    const mobile = String(o.mobile_number || '').trim();
    if (!mobile) { fail('no mobile number'); continue; }

    const items = o.items.map((it, i) => ({
      position: i + 1,
      design_id: it.id ?? null,
      design_name: String(it.name || '').trim(),
      image_url: it.image,
      price: money(it.price),
      final_price: money(it.final_price ?? it.price),
    }));
    if (items.some((it) => !it.design_name || !it.image_url || Number.isNaN(it.price) || Number.isNaN(it.final_price))) { fail('incomplete item'); continue; }

    for (const it of items) {
      const cats = designs.get(String(it.design_id)) || [];
      if (cats.length === 1) it.design_category = cats[0];
      else {
        it.design_category = null;
        if (cats.length === 0) stats.itemsUnmatchedDesign++; else stats.itemsAmbiguousDesign++;
      }
    }

    const itemsTotal = money(items.reduce((n, it) => n + it.final_price, 0));
    const total = money(o.final_price);
    const fee = money(total - itemsTotal);
    if (fee < 0) { fail(`total ${total} is less than items ${itemsTotal}`); continue; }
    stats.feeValues[fee] = (stats.feeValues[fee] || 0) + 1;

    const status = String(o.payment_status || '').trim().toLowerCase();
    if (status !== o.payment_status) stats.statusTrimmed++;
    if (!['pending', 'captured', 'failed', 'refunded'].includes(status)) { fail(`unknown payment status "${o.payment_status}"`); continue; }

    let paymentId = o.razorpay_payment_id || null;
    if (!paymentId) { paymentId = o.payment_id || null; if (paymentId) stats.paymentIdFilled++; }
    if (!paymentId || !o.razorpay_order_id) { fail('missing razorpay ids'); continue; }

    const customers = byPhone.get(mobile) || [];
    if (customers.length === 0) stats.noCustomer++;
    if (customers.length > 1) stats.ambiguousCustomer++;

    orders.push({
      id: o.order_id,
      customer_id: customers[0] ?? null, // lowest id if a mobile is shared
      mobile_number: mobile,
      items_total: itemsTotal,
      platform_fee: fee,
      total,
      currency: o.currency || 'INR',
      payment_status: status,
      razorpay_order_id: o.razorpay_order_id,
      razorpay_payment_id: paymentId,
      razorpay_signature: o.razorpay_signature || null,
      email_sent: o.email_sent === true,
      created_at: o.created_at,
      items,
    });
  }
  return { orders, rejected, stats };
}

(async () => {
  const [source, lookups] = await Promise.all([fetchOrders(), loadLookups()]);
  const { orders, rejected, stats } = build(source, lookups);

  console.log({
    source: source.length,
    ordersToImport: orders.length,
    itemsToImport: orders.reduce((n, o) => n + o.items.length, 0),
    ...stats,
    rejected: rejected.length,
    mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (rejected.length) console.log('rejected:', rejected.slice(0, 20));
  if (!COMMIT) return;

  const client = await pool.connect();
  let inserted = 0;
  let itemsInserted = 0;
  try {
    await client.query('BEGIN');
    for (const o of orders) {
      const { items, ...row } = o;
      const cols = Object.keys(row);
      const r = await client.query(
        `INSERT INTO orders (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
        cols.map((c) => row[c])
      );
      if (r.rowCount === 0) continue; // already imported: its items are already there too
      inserted++;
      for (const it of items) {
        await client.query(
          `INSERT INTO order_items (order_id, position, design_id, design_category, design_name, image_url, price, final_price)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [o.id, it.position, it.design_id, it.design_category, it.design_name, it.image_url, it.price, it.final_price]
        );
        itemsInserted++;
      }
    }
    await client.query(`SELECT setval(pg_get_serial_sequence('orders', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM orders), 1))`);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  const { rows } = await pool.query('SELECT (SELECT COUNT(*) FROM orders)::int AS orders, (SELECT COUNT(*) FROM order_items)::int AS items');
  console.log({ ordersInserted: inserted, itemsInserted, skippedAlreadyPresent: orders.length - inserted, tableTotals: rows[0] });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
