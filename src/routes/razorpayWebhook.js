const crypto = require('crypto');
const express = require('express');
const { Router } = require('express');
const pool = require('../db');
const notify = require('../notify');

const router = Router();

/**
 * @openapi
 * /api/razorpay/webhook:
 *   post:
 *     tags: [Store]
 *     summary: Razorpay's server-to-server events (payment failed, refund processed). Checked with the webhook secret; sends the emails
 *     responses:
 *       200: { description: Received }
 *       400: { description: Bad signature }
 *       503: { description: The webhook secret is not set on the server }
 */
// The signature is made over the exact bytes Razorpay sent, so this route reads the raw body (it is mounted before express.json()).
router.post('/api/razorpay/webhook', express.raw({ type: '*/*', limit: '1mb' }), async (req, res) => {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) { console.error('Razorpay webhook called but RAZORPAY_WEBHOOK_SECRET is not set'); return res.status(503).json({ error: 'Webhooks are not configured' }); }
  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
  const given = Buffer.from(String(req.headers['x-razorpay-signature'] || ''));
  const expected = Buffer.from(crypto.createHmac('sha256', secret).update(raw).digest('hex'));
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return res.status(400).json({ error: 'Invalid signature' });

  let body;
  try { body = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).json({ error: 'Invalid body' }); }
  const event = String(body?.event || '');
  const eventId = String(req.headers['x-razorpay-event-id'] || '') || crypto.createHash('sha256').update(raw).digest('hex');

  try {
    // handled once: a retry of the same event is acknowledged and ignored
    const fresh = await pool.query('INSERT INTO webhook_events (event_id, event) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id', [eventId.slice(0, 100), event.slice(0, 60)]);
    if (!fresh.rows[0]) return res.json({ received: true, duplicate: true });

    if (event === 'payment.failed') {
      const p = body.payload?.payment?.entity || {};
      notify.paymentFailed({ orderId: p.order_id, paymentId: p.id, amountPaise: p.amount, reason: p.error_description || p.error_reason });
    } else if (event === 'refund.processed') {
      const r = body.payload?.refund?.entity || {};
      notify.paymentRefunded({ paymentId: r.payment_id, refundId: r.id, amountPaise: r.amount });
    }
    res.json({ received: true });
  } catch (err) {
    console.error('POST /api/razorpay/webhook failed:', err.message);
    res.status(500).json({ error: 'Could not handle the event' }); // Razorpay will retry
  }
});

module.exports = router;
