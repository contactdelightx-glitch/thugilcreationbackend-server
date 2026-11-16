const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

// a fake Brevo: remembers every email it is asked to send
const sent = [];
let brevoStatus = 201;
const brevo = http.createServer((req, res) => {
  let b = '';
  req.on('data', (c) => { b += c; });
  req.on('end', () => {
    sent.push({ url: req.url, key: req.headers['api-key'], body: JSON.parse(b || '{}') });
    res.writeHead(brevoStatus, { 'Content-Type': 'application/json' });
    res.end(brevoStatus === 201 ? '{"messageId":"x"}' : '{"message":"Key not found"}');
  });
});

const SECRET = 'test-webhook-secret';
const env = {};
let app; let pool; let server; let base; let mailer; let notify;

before(async () => {
  await new Promise((r) => brevo.listen(0, r));
  Object.assign(env, { BREVO_API_BASE: `http://localhost:${brevo.address().port}`, BREVO_API_KEY: 'test-key', MAIL_FROM_EMAIL: 'shop@example.com', MAIL_FROM_NAME: 'Shop', ADMIN_EMAIL: 'owner@example.com, second@example.com', RAZORPAY_WEBHOOK_SECRET: SECRET, SITE_URL: 'https://shop.example.com' });
  Object.assign(process.env, env);
  app = require('../src/app');
  pool = require('../src/db');
  mailer = require('../src/mailer');
  notify = require('../src/notify');
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  brevo.close();
  await pool.end();
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const signed = (obj, id) => {
  const raw = JSON.stringify(obj);
  return { raw, headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': crypto.createHmac('sha256', SECRET).update(raw).digest('hex'), ...(id ? { 'x-razorpay-event-id': id } : {}) } };
};

test('sendMail posts to Brevo with the key, sender and recipients, and escapes nothing it should not', async () => {
  sent.length = 0;
  const ok = await mailer.sendMail({ to: [{ email: 'a@example.com', name: 'A' }, 'not-an-email'], subject: 'Hello', html: '<p>x</p>', tags: ['t'] });
  assert.strictEqual(ok, true);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0].url, '/v3/smtp/email');
  assert.strictEqual(sent[0].key, 'test-key');
  assert.deepStrictEqual(sent[0].body.sender, { name: 'Shop', email: 'shop@example.com' });
  assert.deepStrictEqual(sent[0].body.to, [{ email: 'a@example.com', name: 'A' }]); // the invalid address is dropped
  assert.strictEqual(sent[0].body.subject, 'Hello');
  assert.strictEqual(mailer.esc('<b>"x"&</b>'), '&lt;b&gt;&quot;x&quot;&amp;&lt;/b&gt;');
  // nobody to send to: nothing is sent
  assert.strictEqual(await mailer.sendMail({ to: ['bad'], subject: 's', html: 'h' }), false);
  assert.strictEqual(sent.length, 1);
});

test('a refused or unreachable Brevo never throws', async () => {
  brevoStatus = 401;
  assert.strictEqual(await mailer.sendMail({ to: 'a@example.com', subject: 's', html: 'h' }), false);
  brevoStatus = 201;
  const saved = process.env.BREVO_API_BASE;
  process.env.BREVO_API_BASE = 'http://localhost:1';
  assert.strictEqual(await mailer.sendMail({ to: 'a@example.com', subject: 's', html: 'h' }), false);
  process.env.BREVO_API_BASE = saved;
});

test('doubt alert goes to every admin address and escapes the question', async () => {
  sent.length = 0;
  await notify.doubtAsked({ doubtId: 1, courseId: 2, studentName: 'Asha', studentEmail: 'asha@example.com', lesson: 'Intro', question: '<script>alert(1)</script> help?' });
  assert.strictEqual(sent.length, 1);
  assert.deepStrictEqual(sent[0].body.to.map((t) => t.email), ['owner@example.com', 'second@example.com']);
  assert.ok(sent[0].body.subject.includes('Asha'));
  assert.ok(!sent[0].body.htmlContent.includes('<script>'));
  assert.ok(sent[0].body.htmlContent.includes('&lt;script&gt;'));
});

test('webhook: payment failed and refund emails, signature check and duplicate protection', async () => {
  const ids = [`tmp-evt-${Date.now()}-a`, `tmp-evt-${Date.now()}-b`];
  const u = (await pool.query("INSERT INTO users (email, password_hash, full_name) VALUES ('tmp-mail-test@example.com', 'x', 'Mail Tester') RETURNING customer_id")).rows[0];
  const orderId = `order_tmp_${Date.now()}`;
  await pool.query('INSERT INTO checkout_sessions (razorpay_order_id, customer_id, amount, items) VALUES ($1, $2, 500, $3)', [orderId, u.customer_id, JSON.stringify([{ category: 'butta', design_id: 1, name: 'X', final_price: 500 }])]);
  try {
    // a wrong signature is refused and sends nothing
    sent.length = 0;
    const bad = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-razorpay-signature': 'nope' }, body: '{"event":"payment.failed"}' });
    assert.strictEqual(bad.status, 400);
    await wait(150);
    assert.strictEqual(sent.length, 0);

    // payment failed: the shopper and the admin are told
    const failed = signed({ event: 'payment.failed', payload: { payment: { entity: { id: 'pay_tmp1', order_id: orderId, amount: 50000, error_description: 'Card declined' } } } }, ids[0]);
    const ok = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: failed.headers, body: failed.raw });
    assert.strictEqual(ok.status, 200);
    await wait(500);
    const toShopper = sent.find((m) => m.body.to.some((t) => t.email === 'tmp-mail-test@example.com'));
    assert.ok(toShopper, 'the shopper gets an email');
    assert.strictEqual(toShopper.body.subject, 'Your payment did not go through');
    assert.ok(toShopper.body.htmlContent.includes('Card declined') && toShopper.body.htmlContent.includes('₹500'));
    assert.ok(sent.find((m) => m.body.to.some((t) => t.email === 'owner@example.com') && m.body.subject.startsWith('Payment failed')), 'the admin gets one');
    const count = sent.length;

    // Razorpay retries the same event: acknowledged, no second email
    const again = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: failed.headers, body: failed.raw });
    assert.strictEqual((await again.json()).duplicate, true);
    await wait(300);
    assert.strictEqual(sent.length, count);

    // refund of a payment we do not know: still tells the admin
    const refund = signed({ event: 'refund.processed', payload: { refund: { entity: { id: 'rfnd_tmp1', payment_id: 'pay_unknown_tmp', amount: 12300 } } } }, ids[1]);
    const r = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: refund.headers, body: refund.raw });
    assert.strictEqual(r.status, 200);
    await wait(500);
    assert.ok(sent.find((m) => m.body.subject.startsWith('Refund processed') && m.body.htmlContent.includes('₹123')));

    // other events are accepted and ignored
    const other = signed({ event: 'payment.captured', payload: {} }, `tmp-evt-${Date.now()}-c`);
    assert.strictEqual((await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: other.headers, body: other.raw })).status, 200);
    ids.push(`tmp-evt-${Date.now()}-c`);
  } finally {
    await pool.query('DELETE FROM checkout_sessions WHERE razorpay_order_id = $1', [orderId]);
    await pool.query('DELETE FROM users WHERE customer_id = $1', [u.customer_id]);
    await pool.query("DELETE FROM webhook_events WHERE event_id LIKE 'tmp-evt-%'");
  }
});

test('webhook without a secret on the server answers 503', async () => {
  const saved = process.env.RAZORPAY_WEBHOOK_SECRET;
  delete process.env.RAZORPAY_WEBHOOK_SECRET;
  const r = await fetch(`${base}/api/razorpay/webhook`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
  process.env.RAZORPAY_WEBHOOK_SECRET = saved;
  assert.strictEqual(r.status, 503);
});
