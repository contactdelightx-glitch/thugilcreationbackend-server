const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');
const app = require('../src/app');
const pool = require('../src/db');
const s3 = require('../src/s3');
const { signToken } = require('../src/auth');

let server; let base; let fake; const saved = {};
before(async () => {
  // a fake Razorpay (orders only), so the package payment can be tried without any real payment
  fake = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; });
    req.on('end', () => { const b = JSON.parse(raw || '{}'); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: `order_TMPPKG${Date.now()}${Math.floor(Math.random() * 1000)}`, amount: b.amount })); });
  });
  await new Promise((r) => fake.listen(0, r));
  Object.assign(saved, { b: process.env.RAZORPAY_API_BASE, s: process.env.RAZORPAY_KEY_SECRET, k: process.env.RAZORPAY_KEY_ID });
  process.env.RAZORPAY_API_BASE = `http://localhost:${fake.address().port}`;
  process.env.RAZORPAY_KEY_SECRET = 'tmp_pkg_secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_TMPPKG';
  server = app.listen(0); base = `http://localhost:${server.address().port}`;
});
after(async () => {
  for (const [k, v] of [['RAZORPAY_API_BASE', saved.b], ['RAZORPAY_KEY_SECRET', saved.s], ['RAZORPAY_KEY_ID', saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  server.close(); fake.close(); await pool.end();
});

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const form = (fields, files = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [name, buf] of files) f.append('images', new Blob([buf]), name);
  return f;
};
const GOOD = { name: 'Tmp Requester', email: 'tmp-request@example.com', phone: '+91 98765 43210', requirement: 'I need a pallu design with peacocks and a zari border.', notes: 'Wedding saree', source: 'app' };
const json = { 'Content-Type': 'application/json' };
const admin = (path, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: json, body: body ? JSON.stringify(body) : undefined });
const PKG = (extra = {}) => ({ name: 'TMP PKG', description: 'Quick work', details: 'One design\nFree changes', price: 499, cost_percent: 75, delivery_days: 3, validity_days: 30, ...extra });

test('packages: the admin manages them, a customer subscribes, sends work and follows its progress', async () => {
  const pkgIds = []; const reqIds = []; let userId; let userId2;
  const mkUser = async (email) => (await pool.query("INSERT INTO users (email, password_hash, full_name, phone) VALUES ($1, 'x', 'Tmp Subscriber', '9000000000') RETURNING customer_id", [email])).rows[0].customer_id;
  try {
    // ---- the admin adds packages (and the rules are checked) ----
    const bad = await admin('/api/design-packages', 'POST', { name: '', price: -1, cost_percent: 150, delivery_days: 0 });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(Object.keys((await bad.json()).fields).sort(), ['cost_percent', 'delivery_days', 'name', 'price']);
    const paid = await (await admin('/api/design-packages', 'POST', PKG())).json();
    const free = await (await admin('/api/design-packages', 'POST', PKG({ name: 'TMP FREE', price: 0, cost_percent: 90, delivery_days: 7, max_requests: 1 }))).json();
    const hidden = await (await admin('/api/design-packages', 'POST', PKG({ name: 'TMP HIDDEN', is_active: false }))).json();
    pkgIds.push(paid.id, free.id, hidden.id);
    assert.deepStrictEqual([paid.price, paid.cost_percent, paid.delivery_days, paid.validity_days, paid.max_requests, paid.is_active], [499, 75, 3, 30, null, true]);
    const edited = await (await admin(`/api/design-packages/${paid.id}`, 'PATCH', { price: 599, details: 'One design\nTwo changes' })).json();
    assert.deepStrictEqual([edited.price, edited.details], [599, 'One design\nTwo changes']);
    assert.strictEqual((await admin(`/api/design-packages/${paid.id}`, 'PATCH', { cost_percent: 0 })).status, 400);

    // customers only see the packages that are switched on
    const shown = (await (await fetch(`${base}/api/store/design-packages`)).json()).data;
    assert.ok(shown.some((p) => p.id === paid.id) && shown.some((p) => p.id === free.id) && !shown.some((p) => p.id === hidden.id));

    // ---- sending work needs a login, then a package ----
    userId = await mkUser('tmp-request@example.com');
    const auth = { Authorization: `Bearer ${signToken(userId)}` };
    const send = (extra = {}, headers = auth, files = []) => fetch(`${base}/api/store/design-requests`, { method: 'POST', headers, body: form({ ...GOOD, ...extra }, files) });
    assert.strictEqual((await send({}, {})).status, 401);
    const noPkg = await send();
    assert.strictEqual(noPkg.status, 403);
    assert.strictEqual((await noPkg.json()).needs_package, true);
    assert.strictEqual((await (await fetch(`${base}/api/store/design-subscription`, { headers: auth })).json()).subscription, null);

    // ---- paying for a package (fake Razorpay) ----
    const co = await fetch(`${base}/api/store/design-packages/${paid.id}/checkout`, { method: 'POST', headers: auth });
    assert.strictEqual(co.status, 200);
    const order = await co.json();
    assert.strictEqual(order.amount, 59900);
    assert.strictEqual((await fetch(`${base}/api/store/design-packages/${hidden.id}/checkout`, { method: 'POST', headers: auth })).status, 404);
    const verify = (sig) => fetch(`${base}/api/store/design-packages/checkout/verify`, { method: 'POST', headers: { ...auth, ...json }, body: JSON.stringify({ razorpay_order_id: order.orderId, razorpay_payment_id: 'pay_TMPPKG1', razorpay_signature: sig }) });
    assert.strictEqual((await verify('wrong')).status, 400);
    const sig = crypto.createHmac('sha256', 'tmp_pkg_secret').update(`${order.orderId}|pay_TMPPKG1`).digest('hex');
    const ok = await verify(sig);
    assert.strictEqual(ok.status, 200);
    const sub1 = await ok.json();
    assert.strictEqual((await (await verify(sig)).json()).already, true); // the same payment twice gives the same package
    assert.strictEqual((await fetch(`${base}/api/store/design-packages/${free.id}/checkout`, { method: 'POST', headers: auth })).status, 409); // one package at a time
    const mine = (await (await fetch(`${base}/api/store/design-subscription`, { headers: auth })).json()).subscription;
    assert.deepStrictEqual([mine.package_name, mine.cost_percent, mine.delivery_days, mine.used, mine.days_left], ['TMP PKG', 75, 3, 0, 30]);
    assert.strictEqual(sub1.subscriptionId, mine.id);
    // the package's terms are copied: changing the package later does not change what was bought
    await admin(`/api/design-packages/${paid.id}`, 'PATCH', { cost_percent: 50, delivery_days: 10 });
    const still = (await (await fetch(`${base}/api/store/design-subscription`, { headers: auth })).json()).subscription;
    assert.deepStrictEqual([still.cost_percent, still.delivery_days], [75, 3]);

    // ---- sending a work ----
    assert.strictEqual((await send({ requirement: 'short' })).status, 400);
    assert.strictEqual((await send({}, auth, [['fake.png', Buffer.from('not a picture')]])).status, 400);
    assert.strictEqual((await send({}, auth, [['a.png', PNG], ['b.png', PNG], ['c.png', PNG]])).status, 400);
    assert.strictEqual((await send({}, auth, [['big.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)])]])).status, 400);
    const made = await send({}, auth, [['a.png', PNG], ['b.png', PNG]]);
    assert.strictEqual(made.status, 201);
    const rid = (await made.json()).id; reqIds.push(rid);

    // the admin sees it with the package terms and a due date
    const row = (await (await admin('/api/design-requests?search=tmp-request&status=new')).json()).data.find((x) => x.id === rid);
    assert.deepStrictEqual([row.package_name, row.cost_percent, row.delivery_days, row.image_count, row.status, row.source], ['TMP PKG', 75, 3, 2, 'new', 'app']);
    const due = new Date(); due.setDate(due.getDate() + 3);
    assert.strictEqual(new Date(`${row.due_date}T00:00:00`).toDateString(), due.toDateString());
    for (const n of [1, 2]) {
      const img = await fetch(`${base}/api/design-requests/${rid}/images/${n}`);
      assert.deepStrictEqual([img.status, img.headers.get('content-type')], [200, 'image/png']);
    }
    assert.strictEqual((await fetch(`${base}/api/design-requests/${rid}/images/3`)).status, 404);

    // ---- progress: the admin moves it along, the customer sees every step ----
    assert.strictEqual((await admin(`/api/design-requests/${rid}`, 'PATCH', { status: 'weird' })).status, 400);
    assert.strictEqual((await admin(`/api/design-requests/${rid}`, 'PATCH', { due_date: 'tomorrow' })).status, 400);
    assert.strictEqual((await admin(`/api/design-requests/${rid}`, 'PATCH', { normal_cost: -5 })).status, 400);
    const a = await (await admin(`/api/design-requests/${rid}`, 'PATCH', { status: 'in_progress', message: 'Started on the peacock pallu', normal_cost: 2000, due_date: '2030-01-15' })).json();
    assert.deepStrictEqual([a.status, a.normal_cost, a.quoted_price, a.due_date], ['in_progress', 2000, 1500, '2030-01-15']); // 75% of 2000
    const b = await (await admin(`/api/design-requests/${rid}`, 'PATCH', { status: 'done', message: 'Delivered, thank you' })).json();
    assert.strictEqual(b.status, 'done');
    assert.ok(b.delivered_at);
    const list = (await (await fetch(`${base}/api/store/design-requests/mine`, { headers: auth })).json()).data;
    assert.strictEqual(list.length, 1);
    assert.deepStrictEqual(list[0].updates.map((u) => [u.status, u.message]), [['new', 'We received your work.'], ['in_progress', 'Started on the peacock pallu'], ['done', 'Delivered, thank you']]);
    assert.deepStrictEqual([list[0].quoted_price, list[0].due_date, list[0].package_name], [1500, '2030-01-15', 'TMP PKG']);
    assert.strictEqual((await fetch(`${base}/api/store/design-requests/mine`)).status, 401);
    // another customer sees none of it
    userId2 = await mkUser('tmp-request2@example.com');
    assert.strictEqual((await (await fetch(`${base}/api/store/design-requests/mine`, { headers: { Authorization: `Bearer ${signToken(userId2)}` } })).json()).data.length, 0);

    // ---- finished files: the admin attaches them, only the owner can download ----
    const wf = new FormData();
    wf.append('status', 'review'); wf.append('message', 'First draft is ready');
    wf.append('files', new Blob([PNG], { type: 'image/png' }), 'draft.png');
    const rv = await fetch(`${base}/api/design-requests/${rid}`, { method: 'PATCH', body: wf });
    assert.strictEqual(rv.status, 200);
    const rvj = await rv.json();
    assert.deepStrictEqual([rvj.status, rvj.files.length, rvj.files[0].name], ['review', 1, 'draft.png']);
    const myWork = (await (await fetch(`${base}/api/store/design-requests/mine`, { headers: auth })).json()).data[0];
    const fid = myWork.updates.at(-1).files[0].id;
    const dl = await fetch(`${base}/api/store/design-requests/${rid}/files/${fid}`, { headers: auth });
    assert.deepStrictEqual([dl.status, dl.headers.get('content-disposition')], [200, 'attachment; filename="draft.png"']);
    assert.ok(Buffer.from(await dl.arrayBuffer()).equals(PNG));
    assert.strictEqual((await fetch(`${base}/api/store/design-requests/${rid}/files/${fid}`, { headers: { Authorization: `Bearer ${signToken(userId2)}` } })).status, 404);
    assert.strictEqual((await fetch(`${base}/api/store/design-requests/${rid}/files/${fid}`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/design-requests/${rid}/files/${fid}`)).status, 200);
    const exe = new FormData(); exe.append('files', new Blob(['x']), 'run.exe');
    assert.strictEqual((await fetch(`${base}/api/design-requests/${rid}`, { method: 'PATCH', body: exe })).status, 400);

    // ---- a package that allows one work: the second is refused ----
    const auth2 = { Authorization: `Bearer ${signToken(userId2)}` };
    assert.strictEqual((await (await fetch(`${base}/api/store/design-packages/${free.id}/checkout`, { method: 'POST', headers: auth2 })).json()).free, true);
    assert.strictEqual((await send({}, auth2)).status, 201);
    reqIds.push((await (await admin('/api/design-requests?search=tmp-request&status=new')).json()).data.find((x) => x.id !== rid && x.email === 'tmp-request@example.com').id);
    const over = await send({}, auth2);
    assert.strictEqual(over.status, 403);
    assert.match((await over.json()).error, /allows 1 work/);

    // ---- the admin's numbers, and a bought package cannot be deleted ----
    const sum = await (await admin('/api/design-requests/summary')).json();
    assert.ok(sum.review >= 1 && sum.new >= 1 && sum.total >= 2);
    const listed = (await (await admin('/api/design-packages')).json()).data.find((p) => p.id === paid.id);
    assert.deepStrictEqual([listed.subscribers, listed.active_subscribers], [1, 1]);
    assert.strictEqual((await admin(`/api/design-packages/${paid.id}`, 'DELETE')).status, 409);
    assert.strictEqual((await admin(`/api/design-packages/${hidden.id}`, 'DELETE')).status, 204);
    pkgIds.splice(pkgIds.indexOf(hidden.id), 1);
    assert.ok((await (await admin('/api/design-subscriptions')).json()).data.some((s) => s.email === 'tmp-request@example.com' && s.used === 1));

    // deleting a request removes its pictures
    const refs = (await pool.query('SELECT images FROM design_requests WHERE id = $1', [rid])).rows[0].images;
    assert.strictEqual((await admin(`/api/design-requests/${rid}`, 'DELETE')).status, 204);
    assert.strictEqual(refs.length, 2);
    for (const ref of refs) assert.ok(!(await s3.getPrivate(ref).catch(() => null)), 'picture removed from storage');
    reqIds.shift();
  } finally {
    for (const id of reqIds) {
      const r = (await pool.query('DELETE FROM design_requests WHERE id = $1 RETURNING images', [id])).rows[0];
      for (const ref of r?.images || []) await s3.deletePrivate(ref).catch(() => {});
    }
    const left = await pool.query("DELETE FROM design_requests WHERE email LIKE 'tmp-request%@example.com' RETURNING images");
    for (const r of left.rows) for (const ref of r.images || []) await s3.deletePrivate(ref).catch(() => {});
    await pool.query('DELETE FROM design_subscriptions WHERE customer_id = ANY($1)', [[userId, userId2].filter(Boolean)]);
    await pool.query('DELETE FROM checkout_sessions WHERE customer_id = ANY($1)', [[userId, userId2].filter(Boolean)]);
    await pool.query("DELETE FROM design_packages WHERE name LIKE 'TMP %'");
    await pool.query('DELETE FROM users WHERE customer_id = ANY($1)', [[userId, userId2].filter(Boolean)]);
  }
});
