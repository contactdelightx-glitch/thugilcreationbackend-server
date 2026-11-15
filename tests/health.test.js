const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const pool = require('../src/db');

let server;
let base;

before(() => {
  server = app.listen(0);
  base = `http://localhost:${server.address().port}`;
});

after(async () => {
  server.close();
  await pool.end();
});

test('health and swagger endpoints', async () => {
  const h = await fetch(`${base}/health`);
  assert.strictEqual(h.status, 200);
  assert.strictEqual((await h.json()).status, 'ok');

  const d = await fetch(`${base}/health/db`);
  assert.strictEqual(d.status, 200);
  assert.strictEqual((await d.json()).status, 'ok');

  const spec = await (await fetch(`${base}/openapi.json`)).json();
  assert.ok(spec.paths['/health']);
  assert.ok(spec.paths['/api/users']);
  assert.strictEqual((await fetch(`${base}/docs/`)).status, 200);
});

test('users list is paginated and never exposes password hashes', async () => {
  const r = await fetch(`${base}/api/users?limit=5&search=a`);
  assert.strictEqual(r.status, 200);
  const body = await r.json();
  assert.ok(Array.isArray(body.data));
  assert.ok(body.data.length <= 5);
  assert.ok(!JSON.stringify(body).includes('password'));
});

test('status change and delete work on a throwaway user', async () => {
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash) VALUES ('tmp-status-test@example.com', 'x') RETURNING customer_id"
  );
  const id = rows[0].customer_id;
  const json = { 'Content-Type': 'application/json' };
  try {
    for (const status of ['suspended', 'removed', 'active']) {
      const r = await fetch(`${base}/api/users/${id}/status`, { method: 'PATCH', headers: json, body: JSON.stringify({ status }) });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).status, status);
    }
    const bad = await fetch(`${base}/api/users/${id}/status`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'nope' }) });
    assert.strictEqual(bad.status, 400);
    const missing = await fetch(`${base}/api/users/999999999/status`, { method: 'PATCH', headers: json, body: JSON.stringify({ status: 'active' }) });
    assert.strictEqual(missing.status, 404);

    const del = await fetch(`${base}/api/users/${id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 204);
    assert.strictEqual((await fetch(`${base}/api/users/${id}`, { method: 'DELETE' })).status, 404);
  } finally {
    await pool.query('DELETE FROM users WHERE customer_id = $1', [id]);
  }
});

test('designs: categories, list, filters and detail', async () => {
  const cats = await (await fetch(`${base}/api/designs/categories`)).json();
  assert.strictEqual(cats.length, 7);
  assert.strictEqual(cats.reduce((n, c) => n + c.count, 0), 2133);

  const all = await (await fetch(`${base}/api/designs?limit=5`)).json();
  assert.strictEqual(all.total, 2133);
  assert.strictEqual(all.data.length, 5);

  const full = await (await fetch(`${base}/api/designs?category=full_set`)).json();
  assert.strictEqual(full.total, 17);
  assert.ok(full.data.every((d) => d.category === 'full_set'));

  assert.ok('jacquard_type' in full.data[0] && 'body_epi' in full.data[0]);
  const butta = await (await fetch(`${base}/api/designs?category=butta&limit=1`)).json();
  assert.ok('cards' in butta.data[0] && 'harness_build' in butta.data[0]);
  const free = await (await fetch(`${base}/api/designs?category=free_image&search=prod`)).json();
  assert.strictEqual(free.status, undefined);
  assert.ok(free.data.length > 0 && 'redirect_url' in free.data[0]);

  const sale = await (await fetch(`${base}/api/designs?category=butta&label=sale`)).json();
  assert.ok(sale.data.every((d) => d.label === 'sale'));

  assert.strictEqual((await fetch(`${base}/api/designs?category=nope`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/designs?category=butta;drop`)).status, 400);

  const one = await (await fetch(`${base}/api/designs/full_set/964`)).json();
  assert.strictEqual(one.jacquard_type, 'powerloom');
  assert.strictEqual((await fetch(`${base}/api/designs/butta/999999999`)).status, 404);
});

test('design label can be changed (throwaway row)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO butta_designs (product_id, name, designer_email, cards, hooks, epi, ppi, image_type, image_url, original_image_url, listing_rate, final_price)
     VALUES ('tmp-label-test', 'TMP', 'tmp@example.com', 1, 1, 1, 1, 'BMP', 'x', 'x', 1, 1) RETURNING id`
  );
  const id = rows[0].id;
  const patch = (cat, i, body) =>
    fetch(`${base}/api/designs/${cat}/${i}/label`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    for (const label of ['sale', 'featured', 'new']) {
      const r = await patch('butta', id, { label });
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).label, label);
    }
    assert.strictEqual((await patch('butta', id, { label: 'bogus' })).status, 400);
    assert.strictEqual((await patch('nope', id, { label: 'sale' })).status, 400);
    assert.strictEqual((await patch('butta', 999999999, { label: 'sale' })).status, 404);
    const check = await pool.query('SELECT label FROM butta_designs WHERE id = $1', [id]);
    assert.strictEqual(check.rows[0].label, 'new');
  } finally {
    await pool.query("DELETE FROM butta_designs WHERE product_id = 'tmp-label-test'");
  }
});

test('design edit and delete (throwaway row)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO butta_designs (product_id, name, designer_email, cards, hooks, epi, ppi, image_type, image_url, original_image_url, listing_rate, final_price)
     VALUES ('tmp-edit-test', 'TMP', 'tmp@example.com', 1, 1, 1, 1, 'BMP', 'x', 'x', 1, 1) RETURNING id`
  );
  const id = rows[0].id;
  const url = `${base}/api/designs/butta/${id}`;
  const patch = (body, u = url) => fetch(u, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const ok = await patch({ name: ' New name ', cards: '120', hooks: 160, final_price: '99.5', harness_build: '', notes: 'hi' });
    assert.strictEqual(ok.status, 200);
    const row = await ok.json();
    assert.strictEqual(row.name, 'New name');
    assert.strictEqual(row.cards, 120);
    assert.strictEqual(row.final_price, '99.50');
    assert.strictEqual(row.harness_build, null);

    const bad = await patch({ cards: -1, label: 'x', name: '' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(Object.keys((await bad.json()).fields).sort(), ['cards', 'label', 'name']);

    assert.strictEqual((await patch({ product_id: 'hack' })).status, 400); // not editable
    assert.strictEqual((await patch({ image_url: 'http://x' })).status, 400);
    assert.strictEqual((await patch({})).status, 400);
    assert.strictEqual((await patch({ name: 'x' }, `${base}/api/designs/butta/999999999`)).status, 404);

    assert.strictEqual((await fetch(url, { method: 'DELETE' })).status, 204);
    assert.strictEqual((await fetch(url, { method: 'DELETE' })).status, 404);
  } finally {
    await pool.query("DELETE FROM butta_designs WHERE product_id = 'tmp-edit-test'");
  }
});

test('design create for each kind of category (throwaway rows)', async () => {
  const post = (cat, body) =>
    fetch(`${base}/api/designs/${cat}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const designer = (await pool.query("SELECT email FROM designers WHERE status = 'active' ORDER BY id LIMIT 1")).rows[0].email;
  const common = { designer_email: designer.toUpperCase(), image_url: 'https://x.test/a.bmp', original_image_url: 'https://x.test/b.bmp' };
  const created = [];
  try {
    const b = await post('brocade', { ...common, name: 'TMPB', cards: '240', hooks: 480, epi: 100, ppi: 68, harness_build: 'SINGLE', image_type: 'BMP', listing_rate: 300, final_price: '250.5' });
    assert.strictEqual(b.status, 201);
    const brow = await b.json();
    created.push(['brocade_designs', brow.id]);
    assert.strictEqual(brow.label, 'new');
    assert.strictEqual(brow.designer_email, designer.toLowerCase());
    assert.strictEqual(brow.cards, 240);
    assert.ok(brow.product_id.startsWith('prod_'));

    const f = await post('full_set', { ...common, name: 'TMPF', jacquard_type: 'powerloom', ppi: 68, body_epi: 100, image_type: 'BMP', listing_rate: 2000, final_price: 2000 });
    assert.strictEqual(f.status, 201);
    created.push(['full_set_designs', (await f.json()).id]);

    const fr = await post('free_image', { ...common, redirect_url: 'https://youtube.com/@x' });
    assert.strictEqual(fr.status, 201);
    const frow = await fr.json();
    created.push(['free_image_designs', frow.id]);
    assert.strictEqual(frow.final_price, '0.00');

    const bad = await post('butta', { ...common, name: '', cards: -1, label: 'x' });
    assert.strictEqual(bad.status, 400);
    const fields = (await bad.json()).fields;
    assert.ok(fields.name && fields.cards && fields.label && fields.hooks);
    assert.strictEqual((await post('butta', { ...common, designer_email: 'nope' })).status, 400);
    const stranger = await post('butta', { ...common, designer_email: 'not-a-designer@example.com' });
    assert.strictEqual(stranger.status, 400);
    assert.match((await stranger.json()).fields.designer_email, /not a registered designer/);
    assert.strictEqual((await post('butta', { ...common, product_id: 'x' })).status, 400);
    assert.strictEqual((await post('nope', common)).status, 400);
  } finally {
    for (const [table, id] of created) await pool.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  }
});

test('images: list is read from the bucket; bad uploads are rejected before reaching S3', async () => {
  const list = await (await fetch(`${base}/api/images?limit=3`)).json();
  assert.strictEqual(list.data.length, 3);
  assert.ok(list.total > 1000);
  assert.ok(list.data[0].url.startsWith('https://my-saree-orders-bucket.s3.eu-north-1.amazonaws.com/images%2F'));
  assert.ok(new Date(list.data[0].lastModified) >= new Date(list.data[2].lastModified)); // newest first

  const none = await fetch(`${base}/api/images?search=zzzz-no-such-image-zzzz`);
  assert.strictEqual((await none.json()).total, 0);

  const noFile = await fetch(`${base}/api/images`, { method: 'POST' });
  assert.strictEqual(noFile.status, 400);

  const form = new FormData();
  form.append('files', new Blob(['hello']), 'notes.txt');
  const wrongType = await fetch(`${base}/api/images`, { method: 'POST', body: form });
  assert.strictEqual(wrongType.status, 400);
  assert.match((await wrongType.json()).error, /Not an allowed image type/);
});

test('offset paging walks the list without gaps or repeats', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  for (const path of ['/api/users', '/api/designs?category=butta', '/api/images']) {
    const sep = path.includes('?') ? '&' : '?';
    const first = await get(`${path}${sep}limit=7&offset=0`);
    const second = await get(`${path}${sep}limit=7&offset=7`);
    const both = await get(`${path}${sep}limit=14&offset=0`);
    const keyOf = (r) => r.key || `${r.category || ''}-${r.id ?? r.customer_id}`;
    assert.deepStrictEqual([...first.data, ...second.data].map(keyOf), both.data.map(keyOf), path);
    assert.strictEqual(first.hasMore, true);
    const last = await get(`${path}${sep}limit=50&offset=${first.total}`);
    assert.strictEqual(last.data.length, 0);
    assert.strictEqual(last.hasMore, false);
  }
});

test('designers: list for the dropdown', async () => {
  const r = await (await fetch(`${base}/api/designers`)).json();
  assert.strictEqual(r.total, 17);
  assert.ok(r.data.every((d) => d.email && d.email === d.email.toLowerCase() && ['tenant', 'superadmin'].includes(d.type)));
  assert.strictEqual(r.data.filter((d) => d.type === 'superadmin').length, 1);
  assert.ok(!JSON.stringify(r).includes('password'));
  assert.ok(r.data.every((d) => Number.isInteger(d.designs) && d.status && d.created_at));
  const owner = r.data.find((d) => d.type === 'superadmin');
  assert.ok(owner.designs > 100); // the owner account has most of the designs
  const active = await (await fetch(`${base}/api/designers?status=active`)).json();
  assert.ok(active.data.every((d) => d.status === 'active'));
  const sorted = [...r.data].map((d) => d.email).sort((a, b) => a.localeCompare(b));
  assert.deepStrictEqual(r.data.map((d) => d.email.toLowerCase()), sorted.map((e) => e.toLowerCase()).sort());
});

test('designers: suspend blocks new designs; delete keeps designs and hands them to the owner', async () => {
  const json = { 'Content-Type': 'application/json' };
  const tmpEmail = 'tmp-client-test@example.com';
  const owner = (await pool.query("SELECT id, email FROM designers WHERE type = 'superadmin'")).rows[0];
  const tmp = (await pool.query("INSERT INTO designers (email) VALUES ($1) RETURNING id", [tmpEmail])).rows[0];
  const newDesign = () =>
    fetch(`${base}/api/designs/butta`, {
      method: 'POST', headers: json,
      body: JSON.stringify({ name: 'TMPC', cards: 1, hooks: 1, epi: 1, ppi: 1, image_type: 'BMP', listing_rate: 1, final_price: 1,
        designer_email: tmpEmail, image_url: 'https://x.test/a.bmp', original_image_url: 'https://x.test/b.bmp' }),
    });
  const patch = (id, status) => fetch(`${base}/api/designers/${id}/status`, { method: 'PATCH', headers: json, body: JSON.stringify({ status }) });
  try {
    // active: can add a design
    const first = await newDesign();
    assert.strictEqual(first.status, 201);
    const designId = (await first.json()).id;

    // suspended: refused, and the reason says why; existing design untouched
    assert.strictEqual((await patch(tmp.id, 'suspended')).status, 200);
    const refused = await newDesign();
    assert.strictEqual(refused.status, 400);
    assert.match((await refused.json()).fields.designer_email, /suspended/);
    const list = await (await fetch(`${base}/api/designers?status=active`)).json();
    assert.ok(!list.data.some((d) => d.email === tmpEmail));
    assert.strictEqual((await newDesignRowCount()), 1);

    // reactivated: allowed again
    assert.strictEqual((await patch(tmp.id, 'active')).status, 200);
    const again = await newDesign();
    assert.strictEqual(again.status, 201);

    // bad input and owner protection
    assert.strictEqual((await patch(tmp.id, 'bogus')).status, 400);
    assert.strictEqual((await patch(999999999, 'active')).status, 404);
    assert.strictEqual((await patch(owner.id, 'suspended')).status, 400);
    assert.strictEqual((await fetch(`${base}/api/designers/${owner.id}`, { method: 'DELETE' })).status, 400);

    // delete: designer gone, both designs kept and now belong to the owner
    const del = await fetch(`${base}/api/designers/${tmp.id}`, { method: 'DELETE' });
    assert.strictEqual(del.status, 200);
    const result = await del.json();
    assert.deepStrictEqual(result, { deleted: tmpEmail, reassigned: 2, reassignedTo: owner.email });
    assert.strictEqual((await pool.query('SELECT 1 FROM designers WHERE id = $1', [tmp.id])).rowCount, 0);
    const kept = await pool.query("SELECT designer_email FROM butta_designs WHERE name = 'TMPC'");
    assert.strictEqual(kept.rowCount, 2);
    assert.ok(kept.rows.every((r) => r.designer_email === owner.email));
    assert.strictEqual((await fetch(`${base}/api/designers/${tmp.id}`, { method: 'DELETE' })).status, 404);
  } finally {
    await pool.query("DELETE FROM butta_designs WHERE name = 'TMPC'");
    await pool.query('DELETE FROM designers WHERE email = $1', [tmpEmail]);
  }
  async function newDesignRowCount() {
    return (await pool.query("SELECT COUNT(*)::int AS n FROM butta_designs WHERE name = 'TMPC'")).rows[0].n;
  }
});

test('designers: create a client (email, password, status)', async () => {
  const bcrypt = require('bcryptjs');
  const json = { 'Content-Type': 'application/json' };
  const post = (body) => fetch(`${base}/api/designers`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const emails = ['tmp-create-client-a@example.com', 'tmp-create-client-b@example.com'];
  try {
    const ok = await post({ email: '  TMP-Create-Client-A@Example.com ', password: 'Sup3r-Secret-pw', status: 'active' });
    assert.strictEqual(ok.status, 201);
    const row = await ok.json();
    assert.strictEqual(row.email, emails[0]);
    assert.strictEqual(row.type, 'tenant');
    assert.strictEqual(row.status, 'active');
    assert.strictEqual(row.designs, 0);
    assert.ok(!JSON.stringify(row).includes('Sup3r') && !('password_hash' in row) && !('password' in row));

    // stored as a bcrypt hash that matches, never as the plain password
    const stored = (await pool.query('SELECT password_hash FROM designers WHERE id = $1', [row.id])).rows[0].password_hash;
    assert.ok(stored.startsWith('$2') && !stored.includes('Sup3r'));
    assert.strictEqual(await bcrypt.compare('Sup3r-Secret-pw', stored), true);
    assert.strictEqual(await bcrypt.compare('wrong-password', stored), false);

    // the list never exposes it either
    const listed = await (await fetch(`${base}/api/designers`)).json();
    assert.ok(!JSON.stringify(listed).includes('password'));
    assert.ok(listed.data.some((d) => d.email === emails[0]));

    // created suspended: not offered in the active list
    const sus = await post({ email: emails[1], password: 'another-good-pw', status: 'suspended' });
    assert.strictEqual(sus.status, 201);
    assert.strictEqual((await sus.json()).status, 'suspended');
    const active = await (await fetch(`${base}/api/designers?status=active`)).json();
    assert.ok(!active.data.some((d) => d.email === emails[1]));

    // validation
    const dup = await post({ email: emails[0].toUpperCase(), password: 'Sup3r-Secret-pw' });
    assert.strictEqual(dup.status, 400);
    assert.match((await dup.json()).fields.email, /already registered/);
    const bad = await post({ email: 'nope', password: 'short', status: 'weird' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(Object.keys((await bad.json()).fields).sort(), ['email', 'password', 'status']);
    assert.strictEqual((await post({ email: 'x@y.co', password: 'a'.repeat(73) })).status, 400);
    assert.strictEqual((await post({ email: 'tmp-x@example.com', password: 'long-enough-pw', type: 'superadmin' })).status, 400);
    assert.strictEqual((await post({})).status, 400);
  } finally {
    await pool.query('DELETE FROM designers WHERE email = ANY($1)', [[...emails, 'tmp-x@example.com']]);
  }
});

test('orders: list, filters, summary and items', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const all = await get('/api/orders?limit=5');
  const orderCount = (await pool.query('SELECT COUNT(*)::int AS n FROM orders')).rows[0].n; // real test payments add rows, so never hard-code this
  assert.strictEqual(all.total, orderCount);
  assert.strictEqual(all.data.length, 5);
  assert.strictEqual(all.hasMore, true);
  assert.ok(new Date(all.data[0].created_at) >= new Date(all.data[4].created_at)); // newest first
  assert.ok(all.data.every((o) => o.item_count >= 1 && o.razorpay_payment_id && o.customer_name !== undefined));
  assert.ok(!JSON.stringify(all).includes('signature'));

  // offset paging walks the list with no gaps or repeats
  const a = await get('/api/orders?limit=7&offset=0');
  const b = await get('/api/orders?limit=7&offset=7');
  const both = await get('/api/orders?limit=14&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((o) => o.id), both.data.map((o) => o.id));
  assert.strictEqual((await get(`/api/orders?limit=10&offset=${orderCount}`)).hasMore, false);

  // search + status
  const one = await get('/api/orders?search=pay_T3pN');
  assert.ok(one.total >= 1 && one.data.some((o) => o.id === '151'));
  const truth = (await pool.query("SELECT COUNT(*)::int AS n, COALESCE(SUM(total),0)::float AS revenue, COALESCE(SUM(platform_fee),0)::float AS fees FROM orders WHERE payment_status = 'captured'")).rows[0];
  const itemsTruth = (await pool.query("SELECT COUNT(*)::int AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.payment_status = 'captured'")).rows[0].n;
  assert.strictEqual((await get('/api/orders?status=captured')).total, truth.n);
  assert.strictEqual((await get('/api/orders?status=failed')).total, 0);
  assert.strictEqual((await get('/api/orders?search=zzzz-nothing')).total, 0);

  // summary agrees with the data
  const s = await get('/api/orders/summary');
  assert.strictEqual(s.orders, orderCount);
  assert.strictEqual(s.itemsSold, itemsTruth);
  assert.strictEqual(s.revenue, truth.revenue);
  assert.strictEqual(s.fees, truth.fees);

  // items of a multi-item order
  const items = await get('/api/orders/67/items');
  assert.strictEqual(items.data.length, 5);
  assert.deepStrictEqual(items.data.map((i) => i.position), [1, 2, 3, 4, 5]);
  assert.ok(items.data.every((i) => i.design_name && i.image_url));
  assert.strictEqual((await fetch(`${base}/api/orders/999999/items`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/orders/abc/items`)).status, 400);
});

test('orders: month trends for the KPI cards', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const cur = await get('/api/orders/trends');
  assert.match(cur.month, /^\d{4}-\d{2}$/);
  assert.strictEqual(cur.isCurrentMonth, true);
  assert.strictEqual(cur.metrics.revenue.current.length, cur.throughDay); // only up to today
  assert.strictEqual(cur.metrics.revenue.previous.length, cur.previousDaysInMonth);
  assert.ok(cur.firstMonth <= cur.currentMonth);

  // a finished month: numbers agree with a direct query on the same calendar
  const month = '2026-10';
  const t = await get(`/api/orders/trends?month=${month}`);
  assert.strictEqual(t.isCurrentMonth, false);
  assert.strictEqual(t.throughDay, 31);
  assert.strictEqual(t.metrics.revenue.current.length, 31);
  const direct = (await pool.query(
    `SELECT COUNT(*)::int AS orders, COALESCE(SUM(total),0)::float AS revenue,
            COALESCE(SUM((SELECT COUNT(*) FROM order_items i WHERE i.order_id = o.id)),0)::int AS items
       FROM orders o WHERE payment_status = 'captured'
        AND to_char(created_at AT TIME ZONE 'Asia/Kolkata', 'YYYY-MM') = $1`, [month])).rows[0];
  assert.strictEqual(t.metrics.orders.total, direct.orders);
  assert.strictEqual(t.metrics.revenue.total, direct.revenue);
  assert.strictEqual(t.metrics.items.total, direct.items);
  assert.ok(direct.orders > 0);

  // series are cumulative (never go down); average = revenue / orders
  for (const k of ['revenue', 'orders', 'items']) {
    const s = t.metrics[k].current;
    assert.ok(s.every((v, i) => i === 0 || v >= s[i - 1]), k);
  }
  assert.strictEqual(t.metrics.avg.total, Math.round((direct.revenue / direct.orders) * 100) / 100);

  // every captured order falls in exactly one month: monthly totals add up to the whole
  const first = (await get('/api/orders/trends')).firstMonth;
  let sum = 0;
  for (let [y, m] = first.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= cur.currentMonth; m === 12 ? (y++, (m = 1)) : m++) {
    sum += (await get(`/api/orders/trends?month=${y}-${String(m).padStart(2, '0')}`)).metrics.orders.total;
  }
  assert.strictEqual(sum, (await pool.query("SELECT COUNT(*)::int AS n FROM orders WHERE payment_status = 'captured'")).rows[0].n);

  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=2026-13`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=abc`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=2999-01`)).status, 400);
});

// real test purchases add enrolments to the dev database, so these figures are read from it, never hard-coded
async function enrolTruth() {
  const r = (await pool.query(`SELECT COUNT(*)::int AS payments, COUNT(DISTINCT customer_id)::int AS students, COALESCE(SUM(amount_paid), 0)::float AS revenue,
      COUNT(*) FILTER (WHERE certificate_included)::int AS certs, COUNT(*) FILTER (WHERE doubt_support_included)::int AS doubts,
      COALESCE(SUM(certificate_fee + doubt_support_fee), 0)::float AS addons, COALESCE(SUM(certificate_fee), 0)::float AS cert_revenue
    FROM enrollments WHERE payment_status = 'completed'`)).rows[0];
  // certificates students have had issued / have waiting (these change as people use the site)
  const c = (await pool.query("SELECT COUNT(*) FILTER (WHERE status = 'issued')::int AS issued, COUNT(*) FILTER (WHERE status = 'requested')::int AS requested FROM certificates")).rows[0];
  return { ...r, issued: c.issued, requested: c.requested };
}

test('students: only people who purchased a course are listed', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const T = await enrolTruth();

  const sum = await get('/api/students/summary');
  assert.strictEqual(sum.students, T.students); // not the 27 registered learners
  assert.strictEqual(sum.enrollments, T.payments);
  assert.strictEqual(sum.revenue, T.revenue);
  assert.strictEqual(sum.certificatesIssued, T.issued);
  assert.strictEqual(sum.certificatesIncluded, T.certs);
  assert.strictEqual(sum.completed, 0);

  const all = await get('/api/students?limit=100');
  assert.strictEqual(all.total, T.students);
  assert.strictEqual(all.data.length, T.students);
  assert.ok(!JSON.stringify(all).includes('password'));
  assert.ok(all.data.every((r) => r.enrollment_id && r.course_title && r.enrollment_count >= 1)); // everyone has a purchase
  assert.ok(new Date(all.data[0].enrolled_at) >= new Date(all.data[all.data.length - 1].enrolled_at)); // newest first

  // an account that never bought a course is not a student
  const buyers = new Set(all.data.map((r) => r.customer_id));
  const nonBuyer = (await pool.query('SELECT customer_id FROM users ORDER BY customer_id')).rows.find((r) => !buyers.has(String(r.customer_id)));
  assert.ok(nonBuyer);
  assert.strictEqual((await fetch(`${base}/api/students/${nonBuyer.customer_id}/enrollments`)).status, 404);

  assert.ok((await get('/api/students?search=saree')).total === T.students); // matches the course title
  assert.strictEqual((await get('/api/students?search=meena')).total, 1);
  assert.strictEqual((await get('/api/students?search=zzzz-nothing')).total, 0);

  // offset paging has no gaps or repeats
  const a = await get('/api/students?limit=5&offset=0');
  const b = await get('/api/students?limit=5&offset=5');
  const both = await get('/api/students?limit=10&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((r) => r.customer_id), both.data.map((r) => r.customer_id));
  assert.strictEqual((await get(`/api/students?limit=10&offset=${T.students}`)).hasMore, false);

  // details of a student who has a certificate
  const withCert = all.data.find((r) => r.certificate_status === 'issued');
  const d = await get(`/api/students/${withCert.customer_id}/enrollments`);
  assert.strictEqual(d.data.length, 1);
  assert.strictEqual(d.data[0].certificate_status, 'issued');
  assert.ok(d.data[0].certificate_number.startsWith('CERT-'));
  assert.ok(d.data[0].videos_started > 0 && d.data[0].videos_completed <= d.data[0].videos_started);
  assert.strictEqual((await fetch(`${base}/api/students/abc/enrollments`)).status, 400);
});

test('course payments: list, filters, summary and trends', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const T = await enrolTruth();

  const sum = await get('/api/course-payments/summary');
  assert.strictEqual(sum.payments, T.payments);
  assert.strictEqual(sum.revenue, T.revenue);
  assert.ok(Math.abs(sum.average - T.revenue / T.payments) < 1);
  assert.strictEqual(sum.addOnRevenue, T.addons);
  assert.strictEqual(sum.certificates, T.certs);
  assert.strictEqual(sum.doubtSupport, T.doubts);

  const all = await get('/api/course-payments?limit=100');
  assert.strictEqual(all.total, T.payments);
  assert.ok(all.data.every((p) => p.razorpay_payment_id && p.course_title && p.student_email));
  assert.ok(new Date(all.data[0].enrolled_at) >= new Date(all.data[11].enrolled_at)); // newest first
  // every payment adds up: price - discount + certificate + doubt support = paid
  assert.ok(all.data.every((p) => Math.abs(Number(p.base_price) - Number(p.discount_amount) + Number(p.certificate_fee) + Number(p.doubt_support_fee) - Number(p.amount_paid)) < 0.01));
  assert.ok(!JSON.stringify(all).includes('password'));

  assert.strictEqual((await get('/api/course-payments?status=completed')).total, T.payments);
  assert.strictEqual((await get('/api/course-payments?status=failed')).total, 0);
  assert.strictEqual((await get('/api/course-payments?search=meena')).total, 1);
  const one = all.data[3];
  assert.ok((await get(`/api/course-payments?search=${one.razorpay_payment_id}`)).data.some((p) => p.id === one.id));
  assert.strictEqual((await get('/api/course-payments?search=zzzz-nothing')).total, 0);

  const a = await get('/api/course-payments?limit=5&offset=0');
  const b = await get('/api/course-payments?limit=5&offset=5');
  const both = await get('/api/course-payments?limit=10&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((p) => p.id), both.data.map((p) => p.id));

  // trends: every month's payments add up to all 12, and revenue to the total
  const first = (await get('/api/course-payments/trends')).firstMonth;
  const cur = await get('/api/course-payments/trends');
  let n = 0;
  let revenue = 0;
  for (let [y, m] = first.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= cur.currentMonth; m === 12 ? (y++, (m = 1)) : m++) {
    const t = await get(`/api/course-payments/trends?month=${y}-${String(m).padStart(2, '0')}`);
    n += t.metrics.payments.total;
    revenue += t.metrics.revenue.total;
    const rev = t.metrics.revenue.current;
    assert.ok(rev.every((v, i) => i === 0 || v >= rev[i - 1])); // cumulative
  }
  assert.strictEqual(n, T.payments);
  assert.strictEqual(revenue, T.revenue);
  assert.ok(cur.metrics.avg && cur.metrics.addons);
  assert.strictEqual((await fetch(`${base}/api/course-payments/trends?month=abc`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/course-payments/trends?month=2999-01`)).status, 400);
});

test('courses: list, summary and one course in full', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const sum = await get('/api/courses/summary');
  assert.strictEqual(sum.courses, 2);
  assert.strictEqual(sum.published, 1);
  assert.strictEqual(sum.sections, 39);
  assert.strictEqual(sum.videos, 90);
  assert.strictEqual(sum.durationSeconds, 64024 + 12321);
  const T = await enrolTruth();
  const R = (await pool.query("SELECT COUNT(*)::int AS n, ROUND(AVG(rating), 1)::float AS avg FROM course_reviews WHERE is_published AND course_id = 2")).rows[0]; // students add reviews, so read them
  assert.strictEqual(sum.students, T.students);
  assert.strictEqual(sum.revenue, T.revenue);
  assert.strictEqual(sum.reviews, R.n);
  assert.strictEqual(sum.avgRating, R.avg);

  const list = await get('/api/courses');
  assert.strictEqual(list.total, 2);
  assert.strictEqual(list.data[0].is_published, true); // published first
  const main = list.data.find((c) => c.id === '2');
  assert.deepStrictEqual([main.sections, main.videos, main.duration_seconds, main.resources, main.students, main.revenue, main.review_count, main.avg_rating],
    [26, 62, 64024, 27, T.students, T.revenue, R.n, R.avg]);
  const draft = list.data.find((c) => c.id === '3');
  assert.deepStrictEqual([draft.sections, draft.videos, draft.students, draft.revenue, draft.review_count, draft.avg_rating], [13, 28, 0, 0, 0, null]);
  assert.strictEqual(draft.is_published, false);
  // the stored duration label agrees with the videos: 64024 s = 17h 47m
  assert.strictEqual(main.duration, '17h 47m');
  assert.strictEqual(Math.floor(main.duration_seconds / 3600), 17);
  assert.strictEqual(Math.floor((main.duration_seconds % 3600) / 60), 47);

  const full = await get('/api/courses/2');
  assert.strictEqual(full.course.id, '2');
  assert.strictEqual(full.course.title, main.title);
  assert.deepStrictEqual([full.course.sections, full.course.videos, full.course.students, full.course.revenue], [26, 62, T.students, T.revenue]);
  assert.strictEqual(full.sections.length, 26);
  assert.ok(full.sections.every((s, i) => i === 0 || s.position > full.sections[i - 1].position)); // in order
  assert.strictEqual(full.sections.reduce((n, s) => n + s.videos.length, 0), 62);
  assert.ok(full.sections.every((s) => s.videos.every((v, i) => i === 0 || v.position > s.videos[i - 1].position)));
  assert.strictEqual(full.sections.reduce((n, s) => n + s.duration_seconds, 0), 64024);
  assert.strictEqual(full.learningPoints.length, 5);
  assert.strictEqual(full.resources.length, 27);
  assert.ok(full.resources.every((r) => r.video_title && r.section_title));
  assert.strictEqual(full.software.length, 1);
  assert.strictEqual(full.reviews.length, R.n);
  assert.ok(full.reviews.every((r) => r.reviewer && r.rating >= 1 && r.rating <= 5));
  assert.strictEqual(full.promotions.length, 1);
  assert.ok(!JSON.stringify(full).includes('video_url')); // playback links are not sent to the page

  assert.strictEqual((await fetch(`${base}/api/courses/999999`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/courses/abc`)).status, 400);
});

test('courses: create a course with a new category and learning points (throwaway rows)', async () => {
  const json = { 'Content-Type': 'application/json' };
  const post = (body) => fetch(`${base}/api/courses`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const title = 'TMP COURSE CREATE TEST';
  const catName = 'TMP CATEGORY CREATE TEST';
  const before = (await (await fetch(`${base}/api/courses`)).json()).total;
  let courseId;
  try {
    const ok = await post({
      title: `  ${title}  `, description: 'About it', instructor_name: 'Test Teacher', language: 'Tamil', new_category: catName,
      price: '1500', certificate_with_price: 2000, access_months: '3', learning_points: ['First', '  Second  ', '', 'Third'],
    });
    assert.strictEqual(ok.status, 201);
    const c = await ok.json();
    courseId = c.id;
    assert.strictEqual(c.title, title);
    assert.strictEqual(c.status, 'draft'); // draft by default
    assert.strictEqual(c.is_published, false);
    assert.strictEqual(c.price, 1500);
    assert.strictEqual(c.certificate_with_price, 2000);
    assert.strictEqual(c.certificate_without_price, 1500); // the course price is the price without certificate
    assert.strictEqual(c.category, catName);
    assert.strictEqual(c.duration_months, 3);
    assert.deepStrictEqual([c.sections, c.videos, c.students, c.revenue], [0, 0, 0, 0]);

    const full = await (await fetch(`${base}/api/courses/${courseId}`)).json();
    assert.deepStrictEqual(full.learningPoints.map((p) => [p.position, p.text]), [[1, 'First'], [2, 'Second'], [3, 'Third']]); // blanks dropped, trimmed, in order
    assert.strictEqual((await (await fetch(`${base}/api/courses`)).json()).total, before + 1);

    // the new category is offered in the dropdown, and reusing its name does not duplicate it
    const cats = (await (await fetch(`${base}/api/course-categories`)).json()).data;
    assert.strictEqual(cats.filter((x) => x.name === catName).length, 1);
    const second = await post({ title: `${title} 2`, instructor_name: 'T', price: 10, new_category: catName.toLowerCase(), status: 'published' });
    assert.strictEqual(second.status, 201);
    const c2 = await second.json();
    assert.strictEqual(c2.is_published, true);
    assert.strictEqual(c2.status, 'published');
    assert.strictEqual((await (await fetch(`${base}/api/course-categories`)).json()).data.filter((x) => x.name.toLowerCase() === catName.toLowerCase()).length, 1);
    await pool.query('DELETE FROM courses WHERE id = $1', [c2.id]);

    // existing category by id
    const existing = cats.find((x) => x.name !== catName);
    const byId = await post({ title: `${title} 3`, instructor_name: 'T', price: 10, category_id: existing.id });
    assert.strictEqual(byId.status, 201);
    await pool.query('DELETE FROM courses WHERE id = $1', [(await byId.json()).id]);

    // validation
    const dup = await post({ title: title.toLowerCase(), instructor_name: 'T', price: 1 });
    assert.strictEqual(dup.status, 400);
    assert.match((await dup.json()).fields.title, /already used/);
    const bad = await post({ title: '', instructor_name: '', price: -5, certificate_with_price: 'x', access_months: 0, status: 'weird', thumbnail_url: 'ftp://x', learning_points: 'nope' });
    assert.strictEqual(bad.status, 400);
    assert.deepStrictEqual(Object.keys((await bad.json()).fields).sort(),
      ['access_months', 'certificate_with_price', 'instructor_name', 'learning_points', 'price', 'status', 'thumbnail_url', 'title']);
    const cheap = await post({ title: `${title} 4`, instructor_name: 'T', price: 500, certificate_with_price: 100 });
    assert.match((await cheap.json()).fields.certificate_with_price, /at least the course price/);
    assert.strictEqual((await post({ title: `${title} 5`, instructor_name: 'T', price: 1, learning_points: new Array(21).fill('x') })).status, 400);
    assert.strictEqual((await post({ title: `${title} 6`, instructor_name: 'T', price: 1, category_id: 999999 })).status, 400);
    assert.strictEqual((await post({ title: `${title} 7`, instructor_name: 'T', price: 1, category_id: existing.id, new_category: 'x' })).status, 400);
    assert.strictEqual((await post({ title: `${title} 8`, instructor_name: 'T', price: 1, id: 5 })).status, 400); // unknown field
    assert.strictEqual((await post({})).status, 400);
    // sections and software links are created with the course, in order
    const rich = await post({
      title: `${title} 9`, instructor_name: 'T', price: 100,
      sections: [{ title: 'Intro', description: 'Start here' }, { title: '', description: '' }, { title: 'Basics' }],
      software: [{ name: 'Paint tool', download_url: 'https://example.com/get', platform: 'windows', is_required: true, description: 'Run setup' }, {}],
    });
    assert.strictEqual(rich.status, 201);
    const richFull = await (await fetch(`${base}/api/courses/${(await rich.json()).id}`)).json();
    assert.deepStrictEqual(richFull.sections.map((x) => [x.position, x.title, x.is_published]), [[1, 'Intro', false], [2, 'Basics', false]]); // blank row dropped, unpublished
    assert.strictEqual(richFull.software.length, 1);
    assert.deepStrictEqual([richFull.software[0].name, richFull.software[0].is_required, richFull.software[0].platform], ['Paint tool', true, 'windows']);
    assert.strictEqual((await post({ title: `${title} 10`, instructor_name: 'T', price: 1, sections: [{ description: 'no title' }] })).status, 400);
    assert.strictEqual((await post({ title: `${title} 11`, instructor_name: 'T', price: 1, software: [{ name: 'x', download_url: 'ftp://nope' }] })).status, 400);
    assert.strictEqual((await post({ title: `${title} 12`, instructor_name: 'T', price: 1, sections: 'nope' })).status, 400);
    assert.strictEqual((await post({ title: `${title} 13`, instructor_name: 'T', price: 1, learning_points: ['x'.repeat(501)] })).status, 400);
    assert.strictEqual((await post({ title: `${title} 14`, instructor_name: 'T', price: 1, learning_points: ['x'.repeat(500)] })).status, 201);
    await pool.query("DELETE FROM courses WHERE title LIKE 'TMP COURSE CREATE TEST%' AND title <> $1", [title]);
    // nothing leaked from the failed attempts
    assert.strictEqual((await (await fetch(`${base}/api/courses`)).json()).total, before + 1);
  } finally {
    await pool.query("DELETE FROM courses WHERE title LIKE 'TMP COURSE CREATE TEST%'");
    await pool.query("DELETE FROM course_categories WHERE name ILIKE 'TMP CATEGORY CREATE TEST'");
  }
});

test('course thumbnail upload rejects bad requests before reaching S3', async () => {
  assert.strictEqual((await fetch(`${base}/api/courses/thumbnail`, { method: 'POST' })).status, 400);
  const form = new FormData();
  form.append('file', new Blob(['hello']), 'notes.txt');
  const wrong = await fetch(`${base}/api/courses/thumbnail`, { method: 'POST', body: form });
  assert.strictEqual(wrong.status, 400);
  assert.match((await wrong.json()).error, /jpg, png, gif or webp/);
  const big = new FormData();
  big.append('file', new Blob([new Uint8Array(5 * 1024 * 1024 + 10)]), 'big.png');
  const tooBig = await fetch(`${base}/api/courses/thumbnail`, { method: 'POST', body: big });
  assert.strictEqual(tooBig.status, 400);
  assert.match((await tooBig.json()).error, /larger than 5 MB/);
});

test('certificates: list, filters and summary', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const T = await enrolTruth();
  const sum = await get('/api/certificates/summary');
  assert.deepStrictEqual(sum, { total: T.certs, issued: T.issued, requested: T.requested, notRequested: T.certs - T.issued - T.requested, revenue: T.cert_revenue });

  const all = await get('/api/certificates?limit=100');
  assert.strictEqual(all.total, T.certs);
  assert.ok(all.data.every((r) => r.student_email && r.course_title));
  assert.deepStrictEqual(all.data.map((r) => r.status), [...Array(T.requested).fill('requested'), ...Array(T.issued).fill('issued'), ...Array(T.certs - T.issued - T.requested).fill('not_requested')]); // requested first, then issued, then not requested
  const issued = all.data.filter((r) => r.status === 'issued');
  assert.ok(issued.every((r) => r.certificate_number.startsWith('CERT-') && r.issued_at && r.name_on_certificate && r.delivery_email));
  assert.ok(issued.filter((r) => !r.certificate_number.endsWith(`-${r.enrollment_id}`)).every((r) => r.certificate_url), 'certificates from the old site keep their file link');
  assert.ok(all.data.filter((r) => r.status === 'not_requested').every((r) => !r.certificate_number && !r.certificate_url && r.certificate_fee === 1000));

  assert.strictEqual((await get('/api/certificates?status=issued')).total, T.issued);
  assert.strictEqual((await get('/api/certificates?status=not_requested')).total, T.certs - T.issued - T.requested);
  assert.strictEqual((await get('/api/certificates?status=requested')).total, T.requested);
  assert.strictEqual((await get(`/api/certificates?search=${issued[0].certificate_number}`)).total, 1);
  assert.strictEqual((await get('/api/certificates?search=zzzz-nothing')).total, 0);
  assert.strictEqual((await get('/api/certificates?search=saree')).total, T.certs); // matches the course title

  const a = await get('/api/certificates?limit=2&offset=0');
  const b = await get('/api/certificates?limit=2&offset=2');
  const both = await get('/api/certificates?limit=4&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((r) => r.enrollment_id), both.data.map((r) => r.enrollment_id));
  assert.strictEqual((await get('/api/certificates?limit=10&offset=6')).hasMore, false);
});

test('ratings: list, filters and summary', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const sum = await get('/api/ratings/summary');
  assert.deepStrictEqual({ ...sum, last30Days: undefined }, {
    total: 26, average: 5, withReview: 5, forDesigns: 10, general: 16, last30Days: undefined, distribution: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 26 },
  });
  assert.ok(Number.isInteger(sum.last30Days));

  const all = await get('/api/ratings?limit=100');
  assert.strictEqual(all.total, 26);
  assert.ok(new Date(all.data[0].created_at) >= new Date(all.data[25].created_at)); // newest first
  assert.ok(all.data.every((r) => r.rating >= 1 && r.rating <= 5));
  const forDesigns = all.data.filter((r) => r.design_id);
  assert.strictEqual(forDesigns.length, 10);
  assert.ok(forDesigns.every((r) => r.design_category && r.design_category_label)); // every design was matched to a category
  assert.ok(forDesigns.filter((r) => r.design_category !== 'free_image').every((r) => r.design_name)); // and shows its name
  assert.ok(all.data.filter((r) => !r.design_id).every((r) => !r.design_category && !r.design_name));
  assert.ok(all.data.every((r) => r.review === null || r.review === r.review.trim())); // reviews are tidy

  assert.strictEqual((await get('/api/ratings?filter=reviewed')).total, 5);
  assert.strictEqual((await get('/api/ratings?filter=designs')).total, 10);
  assert.strictEqual((await get('/api/ratings?filter=general')).total, 16);
  assert.strictEqual((await get('/api/ratings?stars=5')).total, 26);
  assert.strictEqual((await get('/api/ratings?stars=4')).total, 0);
  assert.strictEqual((await get('/api/ratings?search=good')).total, 2); // "good deisgns" and "Good"
  assert.strictEqual((await get('/api/ratings?search=zzzz-nothing')).total, 0);
  const named = forDesigns.find((r) => r.design_name);
  assert.ok((await get(`/api/ratings?search=${encodeURIComponent(named.design_name)}`)).data.some((r) => r.id === named.id)); // search finds a design by name

  const a = await get('/api/ratings?limit=7&offset=0');
  const b = await get('/api/ratings?limit=7&offset=7');
  const both = await get('/api/ratings?limit=14&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((r) => r.id), both.data.map((r) => r.id));
  assert.strictEqual((await get('/api/ratings?limit=10&offset=26')).hasMore, false);
});

test('doubts: waiting list, answering and filters (throwaway rows)', async () => {
  const json = { 'Content-Type': 'application/json' };
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const put = (id, body) => fetch(`${base}/api/doubts/${id}/answer`, { method: 'PUT', headers: json, body: JSON.stringify(body) });

  // a student who bought doubt support, one who did not, and a video to ask about
  const withSupport = (await pool.query(`SELECT customer_id, course_id, student_email FROM enrollments WHERE payment_status = 'completed' AND doubt_support_included LIMIT 1`)).rows[0];
  const without = (await pool.query(`SELECT customer_id, course_id, student_email FROM enrollments WHERE payment_status = 'completed' AND NOT doubt_support_included LIMIT 1`)).rows[0];
  const video = (await pool.query('SELECT v.id FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = $1 ORDER BY v.id LIMIT 1', [withSupport.course_id])).rows[0];
  const before = await get('/api/doubts/summary');
  const ids = [];
  const add = async (who, question, ago, videoId) => {
    const r = await pool.query(
      `INSERT INTO course_doubts (customer_id, student_email, course_id, video_id, question, created_at) VALUES ($1, $2, $3, $4, $5, NOW() - ($6 || ' days')::interval) RETURNING id`,
      [who.customer_id, who.student_email, who.course_id, videoId, question, String(ago)]
    );
    ids.push(r.rows[0].id);
    return r.rows[0].id;
  };
  try {
    const old = await add(withSupport, 'TMP-DOUBT oldest question', 5, video.id);
    const recent = await add(without, 'TMP-DOUBT newer question', 1, null);

    const sum = await get('/api/doubts/summary');
    assert.strictEqual(sum.pending, before.pending + 2);
    assert.strictEqual(sum.total, before.total + 2);

    // waiting doubts: oldest first, each says whether the student paid for doubt support, and which video it is about
    const pending = (await get('/api/doubts?status=pending&limit=100')).data.filter((d) => d.question.startsWith('TMP-DOUBT'));
    assert.deepStrictEqual(pending.map((d) => d.id), [String(old), String(recent)]);
    assert.strictEqual(pending[0].has_doubt_support, true);
    assert.strictEqual(pending[1].has_doubt_support, false);
    assert.ok(pending[0].video_title && pending[0].section_title && pending[0].course_title);
    assert.strictEqual(pending[1].video_title, null);
    assert.ok(pending.every((d) => d.status === 'pending' && d.answer === null && d.answered_at === null));

    // answering
    assert.strictEqual((await put(old, {})).status, 400);
    assert.strictEqual((await put(old, { answer: '   ' })).status, 400);
    assert.strictEqual((await put(old, { answer: 'x'.repeat(5001) })).status, 400);
    assert.strictEqual((await put(999999999, { answer: 'hi' })).status, 404);
    assert.strictEqual((await put('abc', { answer: 'hi' })).status, 400);
    const answered = await put(old, { answer: '  Use the Paint Brush tool, then press F7.  ' });
    assert.strictEqual(answered.status, 200);
    const body = await answered.json();
    assert.strictEqual(body.status, 'answered');
    assert.strictEqual(body.answer, 'Use the Paint Brush tool, then press F7.'); // trimmed
    assert.ok(body.answered_at);

    // it left the waiting list and is now in the answered list
    const after = await get('/api/doubts?status=pending&limit=100');
    assert.ok(!after.data.some((d) => d.id === String(old)) && after.data.some((d) => d.id === String(recent)));
    const answeredList = (await get('/api/doubts?status=answered&limit=100')).data;
    assert.ok(answeredList.some((d) => d.id === String(old) && d.answer.startsWith('Use the Paint Brush')));
    assert.strictEqual((await get('/api/doubts/summary')).pending, before.pending + 1);
    assert.strictEqual((await get('/api/doubts/summary')).answered, before.answered + 1);

    // changing the answer keeps the original answered time
    const edited = await (await put(old, { answer: 'Updated answer' })).json();
    assert.strictEqual(edited.answered_at, body.answered_at);
    assert.strictEqual(edited.answer, 'Updated answer');

    // search and the "all" order: waiting first, then answered
    assert.ok((await get('/api/doubts?search=Updated answer')).data.some((d) => d.id === String(old)));
    assert.strictEqual((await get('/api/doubts?search=zzzz-nothing')).total, 0);
    const all = (await get('/api/doubts?limit=100')).data.filter((d) => d.question.startsWith('TMP-DOUBT'));
    assert.deepStrictEqual(all.map((d) => d.status), ['pending', 'answered']);

    // the database itself refuses an "answered" doubt without an answer
    await assert.rejects(pool.query(`UPDATE course_doubts SET status = 'answered' WHERE id = $1`, [recent]));
  } finally {
    await pool.query('DELETE FROM course_doubts WHERE id = ANY($1)', [ids]);
  }
  assert.strictEqual((await get('/api/doubts/summary')).total, before.total);
});

test('courses: edit a course, its sections, software and status (throwaway course)', async () => {
  const json = { 'Content-Type': 'application/json' };
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const post = (body) => fetch(`${base}/api/courses`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const put = (id, body) => fetch(`${base}/api/courses/${id}`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  const patchStatus = (id, status) => fetch(`${base}/api/courses/${id}/status`, { method: 'PATCH', headers: json, body: JSON.stringify({ status }) });
  const T = 'TMP COURSE EDIT TEST';
  const realBefore = (await get('/api/courses/2')).course;
  try {
    const made = await (await post({
      title: T, instructor_name: 'Old Teacher', price: 1000, certificate_with_price: 1500, language: 'English', access_months: 3, new_category: 'TMP EDIT CAT A',
      learning_points: ['one', 'two'],
      sections: [{ title: 'Intro' }, { title: 'Middle' }, { title: 'Last' }],
      software: [{ name: 'Tool A', download_url: 'https://example.com/a', platform: 'windows', is_required: true }],
    })).json();
    const id = made.id;
    const first = await get(`/api/courses/${id}`);
    const [s1, s2, s3] = first.sections;
    const sw = first.software[0];
    assert.strictEqual(first.course.category_id !== null, true); // the edit form can pre-select the category

    // edit the basics: price, status, category by id, thumbnail, certificate removed
    const otherCat = (await get('/api/course-categories')).data.find((c) => c.name !== 'TMP EDIT CAT A');
    const edited = await put(id, { title: `  ${T} (renamed)  `, instructor_name: 'New Teacher', price: 2000, status: 'published', category_id: otherCat.id, language: 'Tamil', access_months: 6, thumbnail_url: 'https://example.com/t.png', description: 'Now described' });
    assert.strictEqual(edited.status, 200);
    const c = await edited.json();
    assert.deepStrictEqual([c.title, c.instructor_name, c.price, c.certificate_with_price, c.certificate_without_price, c.status, c.is_published, c.category, c.language, c.duration_months, c.thumbnail_url],
      [`${T} (renamed)`, 'New Teacher', 2000, null, 2000, 'published', true, otherCat.name, 'Tamil', 6, 'https://example.com/t.png']);
    // lists that were left out are untouched
    const same = await get(`/api/courses/${id}`);
    assert.deepStrictEqual(same.sections.map((x) => x.title), ['Intro', 'Middle', 'Last']);
    assert.strictEqual(same.learningPoints.length, 2);
    assert.strictEqual(same.software.length, 1);
    // an empty thumbnail removes it; a title that is the course's own is not a duplicate
    const cleared = await (await put(id, { title: `${T} (renamed)`, instructor_name: 'New Teacher', price: 2000, thumbnail_url: '' })).json();
    assert.strictEqual(cleared.thumbnail_url, null);
    assert.strictEqual(cleared.status, 'draft'); // status not sent = draft, like creating

    // learning points replaced; sections renamed, re-ordered, one added, one removed; software changed
    const base2 = { title: `${T} (renamed)`, instructor_name: 'New Teacher', price: 2000 };
    const sectionsEdit = await put(id, { ...base2, learning_points: ['only one now'],
      sections: [{ id: s3.id, title: 'Last (now first)' }, { id: s1.id, title: 'Intro', description: 'described' }, { title: 'Brand new' }],
      software: [{ id: sw.id, name: 'Tool A v2', download_url: 'https://example.com/a2', platform: 'mac', is_required: false }, { name: 'Tool B', download_url: 'https://example.com/b' }] });
    assert.strictEqual(sectionsEdit.status, 200);
    const after = await get(`/api/courses/${id}`);
    assert.deepStrictEqual(after.sections.map((x) => [x.position, x.title]), [[1, 'Last (now first)'], [2, 'Intro'], [3, 'Brand new']]);
    assert.strictEqual(after.sections[0].id, s3.id); // same section, just moved: its id is unchanged
    assert.strictEqual(after.sections[1].description, 'described');
    assert.ok(!after.sections.some((x) => x.id === s2.id)); // "Middle" had no videos, so it could be removed
    assert.deepStrictEqual(after.learningPoints.map((p) => p.text), ['only one now']);
    assert.deepStrictEqual(after.software.map((x) => [x.name, x.platform, x.is_required]), [['Tool A v2', 'mac', false], ['Tool B', null, false]]);
    assert.strictEqual(after.software[0].id, sw.id);

    // a section that has videos can be renamed and moved, but not removed
    const vid = await pool.query(`INSERT INTO course_videos (section_id, title, position, duration_seconds) VALUES ($1, 'TMP VIDEO', 1, 60) RETURNING id`, [s3.id]);
    const blocked = await put(id, { ...base2, sections: [{ title: 'Intro-only' }] });
    assert.strictEqual(blocked.status, 400);
    assert.match((await blocked.json()).fields.sections, /has 1 video, so it cannot be removed/);
    assert.deepStrictEqual((await get(`/api/courses/${id}`)).sections.map((x) => x.title), ['Last (now first)', 'Intro', 'Brand new']); // nothing changed
    const renamed = await put(id, { ...base2, sections: [{ id: after.sections[1].id, title: 'Intro' }, { id: s3.id, title: 'Renamed, has video' }] });
    assert.strictEqual(renamed.status, 200);
    const afterRename = await get(`/api/courses/${id}`);
    assert.deepStrictEqual(afterRename.sections.map((x) => x.title), ['Intro', 'Renamed, has video']);
    assert.strictEqual(afterRename.sections[1].videos.length, 1); // the video came along with its section

    // everything can be cleared when nothing is attached
    const emptied = await put(id, { ...base2, learning_points: [], software: [] });
    assert.strictEqual(emptied.status, 200);
    const e = await get(`/api/courses/${id}`);
    assert.deepStrictEqual([e.learningPoints.length, e.software.length], [0, 0]);

    // validation and protection
    assert.strictEqual((await put(id, { instructor_name: 'x', price: 1 })).status, 400); // title missing
    const badBody = await put(id, { title: '', instructor_name: '', price: -1, certificate_with_price: 5, access_months: 0, status: 'weird' });
    assert.strictEqual(badBody.status, 400);
    assert.deepStrictEqual(Object.keys((await badBody.json()).fields).sort(), ['access_months', 'instructor_name', 'price', 'status', 'title']); // no certificate message: with an invalid price there is nothing to compare it with
    const realTitle = realBefore.title;
    const dup = await put(id, { title: realTitle.toLowerCase(), instructor_name: 'x', price: 1 });
    assert.strictEqual(dup.status, 400);
    assert.match((await dup.json()).fields.title, /already used/);
    const foreign = await put(id, { ...base2, sections: [{ id: 999999999, title: 'nope' }] });
    assert.strictEqual(foreign.status, 400);
    const otherCourseSection = (await get('/api/courses/2')).sections[0].id;
    assert.strictEqual((await put(id, { ...base2, sections: [{ id: otherCourseSection, title: 'steal' }] })).status, 400); // another course's section
    assert.strictEqual((await put(id, { ...base2, sections: [{ id: afterRename.sections[0].id, title: 'a' }, { id: afterRename.sections[0].id, title: 'b' }] })).status, 400); // same section twice
    assert.strictEqual((await put(id, { ...base2, id: 5 })).status, 400); // unknown field
    assert.strictEqual((await put(999999999, base2)).status, 404);
    assert.strictEqual((await put('abc', base2)).status, 400);

    // publish / take back to draft
    const pub = await (await patchStatus(id, 'published')).json();
    assert.deepStrictEqual([pub.status, pub.is_published], ['published', true]);
    const draft = await (await patchStatus(id, 'draft')).json();
    assert.deepStrictEqual([draft.status, draft.is_published], ['draft', false]);
    assert.strictEqual((await patchStatus(id, 'archived')).status, 400);
    assert.strictEqual((await patchStatus(999999999, 'draft')).status, 404);

    // a real course was not touched by any of this
    const realAfter = (await get('/api/courses/2')).course;
    assert.deepStrictEqual([realAfter.title, realAfter.price, realAfter.sections, realAfter.videos, realAfter.updated_at], [realBefore.title, realBefore.price, realBefore.sections, realBefore.videos, realBefore.updated_at]);
    await pool.query('DELETE FROM course_videos WHERE id = $1', [vid.rows[0].id]);
  } finally {
    await pool.query("DELETE FROM courses WHERE title LIKE 'TMP COURSE EDIT TEST%'");
    await pool.query("DELETE FROM course_categories WHERE name LIKE 'TMP EDIT CAT%'");
  }
});

test('courses: edit the videos in a section (details, order, add, remove) on a throwaway course', async () => {
  const json = { 'Content-Type': 'application/json' };
  const get = async (path) => (await fetch(`${base}${path}`)).json();
  const post = (body) => fetch(`${base}/api/courses`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  const put = (id, body) => fetch(`${base}/api/courses/${id}`, { method: 'PUT', headers: json, body: JSON.stringify(body) });
  const T = 'TMP COURSE VIDEO TEST';
  const link = (n) => `https://cdn.example.com/${n}/playlist.m3u8`;
  const base2 = { title: T, instructor_name: 'Teacher', price: 100 };
  const realBefore = JSON.stringify((await get('/api/courses/2/curriculum')).sections.map((s) => s.videos.map((v) => [v.id, v.title, v.position])));
  const realCourseBefore = (await get('/api/courses/2')).course;
  const anEnrollment = (await pool.query(`SELECT id FROM enrollments ORDER BY id LIMIT 1`)).rows[0].id;
  try {
    // videos can be sent when a course is created
    const made = await (await post({ ...base2, sections: [{ title: 'Sec A', videos: [{ title: 'V1', video_url: link(1), duration_seconds: 600 }, { title: 'V2', duration_seconds: 900 }] }, { title: 'Sec B' }] })).json();
    const id = made.id;
    assert.strictEqual(made.duration, '25m'); // 600 + 900 seconds
    let cur = (await get(`/api/courses/${id}/curriculum`)).sections;
    const [secA, secB] = cur;
    assert.deepStrictEqual(secA.videos.map((v) => [v.position, v.title, v.duration_seconds, v.has_video_link]), [[1, 'V1', 600, true], [2, 'V2', 900, false]]);
    assert.ok(!JSON.stringify(cur).includes('cdn.example.com') && !JSON.stringify(cur).includes('video_url')); // the playback link is never sent back
    const [v1, v2] = secA.videos;

    // edit details, move V2 above V1, add V3 with a link; the existing link stays when none is sent
    const edit1 = await put(id, { ...base2, sections: [
      { id: secA.id, title: 'Sec A', videos: [
        { id: v2.id, title: 'V2 renamed', description: 'about v2', duration_seconds: 1200, is_free_preview: true, is_published: true },
        { id: v1.id, title: 'V1', duration_seconds: 600 },
        { title: 'V3 new', video_url: link(3), duration_seconds: 60 },
      ] },
      { id: secB.id, title: 'Sec B' }] });
    assert.strictEqual(edit1.status, 200);
    cur = (await get(`/api/courses/${id}/curriculum`)).sections;
    assert.deepStrictEqual(cur[0].videos.map((v) => [v.position, v.title, v.is_free_preview, v.is_published, v.has_video_link]),
      [[1, 'V2 renamed', true, true, false], [2, 'V1', false, false, true], [3, 'V3 new', false, false, true]]);
    assert.strictEqual(cur[0].videos[0].id, v2.id); // same video, just moved: its id is unchanged
    assert.strictEqual(cur[0].videos[1].id, v1.id);
    assert.strictEqual((await get(`/api/courses/${id}`)).course.duration, '31m'); // 1200 + 600 + 60 seconds, kept in step
    const stored = (await pool.query('SELECT video_url FROM course_videos WHERE id = $1', [v1.id])).rows[0].video_url;
    assert.strictEqual(stored, link(1)); // V1's link was not touched
    await put(id, { ...base2, sections: [{ id: secA.id, title: 'Sec A', videos: [{ id: v2.id, title: 'V2 renamed', video_url: link('new'), duration_seconds: 1200 }, { id: v1.id, title: 'V1', duration_seconds: 600 }, { id: cur[0].videos[2].id, title: 'V3 new', duration_seconds: 60 }] }, { id: secB.id, title: 'Sec B' }] });
    assert.strictEqual((await pool.query('SELECT video_url FROM course_videos WHERE id = $1', [v2.id])).rows[0].video_url, link('new')); // a new link replaces the old one

    // a section that sends no "videos" keeps its videos
    await put(id, { ...base2, sections: [{ id: secA.id, title: 'Sec A (renamed)' }, { id: secB.id, title: 'Sec B' }] });
    assert.strictEqual((await get(`/api/courses/${id}/curriculum`)).sections[0].videos.length, 3);

    // a video that students watched, or that has a practice file, cannot be removed
    const v3 = cur[0].videos[2];
    await pool.query('INSERT INTO enrollment_video_progress (enrollment_id, video_id) VALUES ($1, $2)', [anEnrollment, v1.id]);
    await pool.query(`INSERT INTO course_resources (course_id, video_id, title) VALUES ($1, $2, 'TMP FILE')`, [id, v3.id]);
    const info = (await get(`/api/courses/${id}/curriculum`)).sections[0].videos;
    assert.deepStrictEqual([info[1].watchers, info[2].files], [1, 1]);
    const keepOnlyV2 = (extra) => ({ ...base2, sections: [{ id: secA.id, title: 'Sec A', videos: [{ id: v2.id, title: 'V2 renamed' }, ...extra] }, { id: secB.id, title: 'Sec B' }] });
    const watched = await put(id, keepOnlyV2([{ id: v3.id, title: 'V3 new' }]));
    assert.strictEqual(watched.status, 400);
    assert.match((await watched.json()).fields.sections, /"V1" cannot be removed: 1 student has watched it/);
    const hasFile = await put(id, keepOnlyV2([{ id: v1.id, title: 'V1' }]));
    assert.strictEqual(hasFile.status, 400);
    assert.match((await hasFile.json()).fields.sections, /"V3 new" cannot be removed: it has 1 practice file/);
    assert.strictEqual((await get(`/api/courses/${id}/curriculum`)).sections[0].videos.length, 3); // the refused edits changed nothing
    await pool.query('DELETE FROM enrollment_video_progress WHERE enrollment_id = $1 AND video_id = $2', [anEnrollment, v1.id]);
    await pool.query('DELETE FROM course_resources WHERE video_id = $1', [v3.id]);
    const removed = await put(id, keepOnlyV2([]));
    assert.strictEqual(removed.status, 200);
    assert.deepStrictEqual((await get(`/api/courses/${id}/curriculum`)).sections[0].videos.map((v) => v.title), ['V2 renamed']);
    assert.strictEqual((await get(`/api/courses/${id}`)).course.duration, '20m');
    const kept = (await get(`/api/courses/${id}/curriculum`)).sections[0].videos[0];
    assert.deepStrictEqual([kept.is_free_preview, kept.is_published, kept.duration_seconds, kept.description], [true, true, 1200, 'about v2']); // not mentioned in the last edit, so unchanged

    // checks
    const secWith = (videos) => ({ ...base2, sections: [{ id: secA.id, title: 'Sec A', videos }, { id: secB.id, title: 'Sec B' }] });
    for (const [label, vids] of [
      ['no title', [{ title: '', description: 'x' }]], ['bad link', [{ title: 'x', video_url: 'ftp://nope' }]], ['bad length', [{ title: 'x', duration_seconds: 99999 }]],
      ['negative length', [{ title: 'x', duration_seconds: -1 }]], ['same video twice', [{ id: v2.id, title: 'a' }, { id: v2.id, title: 'b' }]],
      ['video of another section', [{ id: 999999999, title: 'x' }]], ['not a list', 'nope'],
    ]) assert.strictEqual((await put(id, secWith(vids))).status, 400, label);
    const realVideo = (await get('/api/courses/2/curriculum')).sections[0].videos[0].id;
    assert.strictEqual((await put(id, secWith([{ id: realVideo, title: 'steal' }]))).status, 400); // another course's video
    assert.strictEqual((await put(id, secWith([{}, { title: '' }]))).status, 200); // blank rows are ignored (this empties the section)
    assert.strictEqual((await get(`/api/courses/${id}/curriculum`)).sections[0].videos.length, 0);
    assert.strictEqual((await get(`/api/courses/${id}`)).course.duration, null);
    assert.strictEqual((await fetch(`${base}/api/courses/999999999/curriculum`)).status, 404);

    // the real courses were not touched by any of this
    assert.strictEqual(JSON.stringify((await get('/api/courses/2/curriculum')).sections.map((s) => s.videos.map((v) => [v.id, v.title, v.position]))), realBefore);
    const realCourseAfter = (await get('/api/courses/2')).course;
    assert.deepStrictEqual([realCourseAfter.duration, realCourseAfter.videos, realCourseAfter.updated_at], [realCourseBefore.duration, realCourseBefore.videos, realCourseBefore.updated_at]);
  } finally {
    await pool.query('DELETE FROM enrollment_video_progress WHERE enrollment_id = $1 AND video_id IN (SELECT v.id FROM course_videos v JOIN course_sections s ON s.id = v.section_id JOIN courses c ON c.id = s.course_id WHERE c.title LIKE $2)', [anEnrollment, 'TMP COURSE VIDEO TEST%']);
    await pool.query("DELETE FROM courses WHERE title LIKE 'TMP COURSE VIDEO TEST%'");
  }
});

test('store: public designs list by style and never expose private fields', async () => {
  const cats = await (await fetch(`${base}/api/store/categories`)).json();
  assert.ok(cats.length === 7 && cats.every((c) => typeof c.count === 'number'));
  const r = await (await fetch(`${base}/api/store/designs?category=border&limit=5`)).json();
  assert.ok(r.data.length > 0 && r.data.length <= 5);
  assert.ok(r.data.every((d) => d.category === 'border' && d.image_url));
  const keys = new Set(r.data.flatMap((d) => Object.keys(d)));
  for (const secret of ['designer_email', 'original_image_url', 'notes', 'redirect_url']) assert.ok(!keys.has(secret), `${secret} must not be public`);
  assert.ok(r.data.every((d) => d.cards > 0 && d.hooks > 0 && d.ppi > 0), 'weaving details are included');
  const fs = await (await fetch(`${base}/api/store/designs?category=full_set&limit=2`)).json();
  assert.ok(fs.data.length > 0 && fs.data.every((d) => d.jacquard_type && d.body_epi > 0), 'full set has its own details');
  const next = await (await fetch(`${base}/api/store/designs?category=border&limit=5&offset=5`)).json();
  assert.ok(!next.data.some((d) => r.data.some((x) => x.id === d.id)));
  const all = await (await fetch(`${base}/api/store/designs?limit=3`)).json();
  assert.strictEqual(all.data.length, 3);
  assert.strictEqual((await fetch(`${base}/api/store/designs?category=nope`)).status, 400);
});

test('shopper login and Razorpay checkout (throwaway user, a fake Razorpay server, no real payment)', async () => {
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const http = require('http');
  const json = { 'Content-Type': 'application/json' };

  // a stand-in for Razorpay's order API, so the test never touches the live account
  let lastOrderBody;
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { lastOrderBody = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: `order_TMP${Date.now()}`, amount: lastOrderBody.amount })); });
  });
  await new Promise((r) => fake.listen(0, r));
  const saved = { b: process.env.RAZORPAY_API_BASE, s: process.env.RAZORPAY_KEY_SECRET, k: process.env.RAZORPAY_KEY_ID };
  process.env.RAZORPAY_API_BASE = `http://localhost:${fake.address().port}`;
  process.env.RAZORPAY_KEY_SECRET = 'tmp_test_secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_TMP';

  const hash = bcrypt.hashSync('Correct-Horse-1', 4);
  const { rows } = await pool.query(
    "INSERT INTO users (email, password_hash, full_name, phone) VALUES ('tmp-shopper-test@example.com', $1, 'Tmp Shopper', '9000000000') RETURNING customer_id", [hash]);
  const id = rows[0].customer_id;
  try {
    // ---- login ----
    assert.strictEqual((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'tmp-shopper-test@example.com', password: 'wrong' }) })).status, 401);
    assert.strictEqual((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'nobody@example.com', password: 'x' }) })).status, 401);
    const ok = await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'TMP-shopper-test@example.com', password: 'Correct-Horse-1' }) });
    assert.strictEqual(ok.status, 200);
    const { token, user } = await ok.json();
    assert.ok(token && user.full_name === 'Tmp Shopper' && !('password_hash' in user));
    const auth = { ...json, Authorization: `Bearer ${token}` };
    assert.strictEqual((await (await fetch(`${base}/api/auth/me`, { headers: auth })).json()).user.email, 'tmp-shopper-test@example.com');
    assert.strictEqual((await fetch(`${base}/api/auth/me`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${token.slice(0, -2)}xx` } })).status, 401);
    await pool.query("UPDATE users SET status = 'suspended' WHERE customer_id = $1", [id]);
    assert.strictEqual((await fetch(`${base}/api/auth/login`, { method: 'POST', headers: json, body: JSON.stringify({ email: 'tmp-shopper-test@example.com', password: 'Correct-Horse-1' }) })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/auth/me`, { headers: auth })).status, 401, 'a suspended shopper loses access');
    await pool.query("UPDATE users SET status = 'active' WHERE customer_id = $1", [id]);

    // ---- checkout ----
    const post = (path, body, h = auth) => fetch(`${base}${path}`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.strictEqual((await post('/api/store/checkout', { items: [] }, json)).status, 401);
    assert.strictEqual((await post('/api/store/checkout', { items: [] })).status, 400);
    assert.strictEqual((await post('/api/store/checkout', { items: [{ category: 'nope', id: 1 }] })).status, 400);

    const two = (await pool.query("SELECT id, final_price::float AS p FROM border_designs WHERE final_price > 0 ORDER BY id LIMIT 2")).rows;
    const items = two.map((d) => ({ category: 'border', id: Number(d.id), price: 1 })); // a cheating browser price is ignored
    const co = await post('/api/store/checkout', { items });
    assert.strictEqual(co.status, 200);
    const session = await co.json();
    const expected = Math.round(two.reduce((n, d) => n + d.p, 0) * 100);
    assert.strictEqual(session.amount, expected, 'the amount comes from the database');
    assert.strictEqual(lastOrderBody.amount, expected);
    assert.strictEqual(session.keyId, 'rzp_test_TMP');

    const payId = `pay_TMP${Date.now()}`;
    const goodSig = crypto.createHmac('sha256', 'tmp_test_secret').update(`${session.orderId}|${payId}`).digest('hex');
    const bad = await post('/api/store/checkout/verify', { razorpay_order_id: session.orderId, razorpay_payment_id: payId, razorpay_signature: 'f'.repeat(64) });
    assert.strictEqual(bad.status, 400);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM orders WHERE razorpay_order_id = $1', [session.orderId])).rows[0].n, 0, 'a bad signature saves nothing');
    const good = await post('/api/store/checkout/verify', { razorpay_order_id: session.orderId, razorpay_payment_id: payId, razorpay_signature: goodSig });
    assert.strictEqual(good.status, 200);
    const done = await good.json();
    const saved1 = (await pool.query('SELECT payment_status, total::float AS total, customer_id::text AS c FROM orders WHERE id = $1', [done.orderId])).rows[0];
    assert.deepStrictEqual([saved1.payment_status, saved1.total, saved1.c], ['captured', expected / 100, String(id)]);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM order_items WHERE order_id = $1', [done.orderId])).rows[0].n, 2);
    const mine = await fetch(`${base}/api/store/orders/${done.orderId}`, { headers: auth });
    assert.strictEqual(mine.status, 200);
    const ord = await mine.json();
    assert.deepStrictEqual([ord.total, ord.items.length, ord.payment_id], [expected / 100, 2, payId]);
    assert.ok(ord.items.every((i) => i.name && i.image_url));
    assert.strictEqual((await fetch(`${base}/api/store/orders/${done.orderId}`)).status, 401, 'login required');
    assert.strictEqual((await fetch(`${base}/api/store/orders/999999999`, { headers: auth })).status, 404);
    const pur = await (await fetch(`${base}/api/store/purchases`, { headers: auth })).json();
    assert.strictEqual(pur.data.length, 2);
    const originals = (await pool.query("SELECT original_image_url FROM border_designs WHERE id = ANY($1::bigint[])", [two.map((d) => d.id)])).rows.map((r) => r.original_image_url);
    assert.ok(pur.data.every((d) => originals.includes(d.image_url)), 'the page gets the ORIGINAL image, not the blurred preview');
    assert.strictEqual((await fetch(`${base}/api/store/purchases`)).status, 401);
    const dl = await fetch(`${base}/api/store/purchases/${pur.data[0].item_id}/download`, { headers: auth });
    assert.strictEqual(dl.status, 200);
    assert.match(dl.headers.get('content-disposition'), /^attachment; filename="[^"]+\.bmp"$/);
    assert.ok((await dl.arrayBuffer()).byteLength > 1000, 'the file has content');
    assert.strictEqual((await fetch(`${base}/api/store/purchases/${pur.data[0].item_id}/download`)).status, 401);
    assert.strictEqual((await fetch(`${base}/api/store/purchases/999999999/download`, { headers: auth })).status, 404);
    // ---- reviews of what was bought ----
    const itemId = pur.data[0].item_id;
    const put = (iid, body, h = auth) => fetch(`${base}/api/store/purchases/${iid}/review`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
    assert.strictEqual((await put(itemId, { rating: 5 }, json)).status, 401);
    assert.strictEqual((await put(itemId, { rating: 0 })).status, 400);
    assert.strictEqual((await put(itemId, { rating: 6 })).status, 400);
    assert.strictEqual((await put(itemId, { rating: 4, review: 'x'.repeat(1001) })).status, 400);
    assert.strictEqual((await put(999999999, { rating: 5 })).status, 404, 'only bought designs can be reviewed');
    assert.strictEqual((await put(itemId, { rating: 4, review: '  Lovely design  ' })).status, 200);
    assert.strictEqual((await put(itemId, { rating: 5, review: 'Changed my mind' })).status, 200);
    const mineNow = (await (await fetch(`${base}/api/store/purchases`, { headers: auth })).json()).data.find((d) => d.item_id === itemId);
    assert.deepStrictEqual([mineNow.my_rating, mineNow.my_review], [5, 'Changed my mind']);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM saree_ratings WHERE customer_id = $1', [id])).rows[0].n, 1, 'editing never makes a second review');
    const again = await (await post('/api/store/checkout/verify', { razorpay_order_id: session.orderId, razorpay_payment_id: payId, razorpay_signature: goodSig })).json();
    assert.ok(again.already && again.orderId === done.orderId, 'confirming twice does not create a second order');

    const rebuy = await post('/api/store/checkout', { items: [items[0]] });
    assert.strictEqual(rebuy.status, 409, 'a design already bought cannot be bought again');
  } finally {
    await pool.query('DELETE FROM saree_ratings WHERE customer_id = $1', [id]);
    await pool.query('DELETE FROM orders WHERE customer_id = $1', [id]);
    await pool.query('DELETE FROM checkout_sessions WHERE customer_id = $1', [id]);
    await pool.query('DELETE FROM users WHERE customer_id = $1', [id]);
    fake.close();
    for (const [k, v] of [['RAZORPAY_API_BASE', saved.b], ['RAZORPAY_KEY_SECRET', saved.s], ['RAZORPAY_KEY_ID', saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

test('store: course summary counts published courses only', async () => {
  const r = await (await fetch(`${base}/api/store/courses/summary`)).json();
  for (const k of ['courses', 'videos', 'durationSeconds', 'students', 'reviews']) assert.strictEqual(typeof r[k], 'number', k);
  const published = (await pool.query('SELECT COUNT(*)::int AS n FROM courses WHERE is_published')).rows[0].n;
  assert.strictEqual(r.courses, published);
  const all = (await pool.query('SELECT COUNT(*)::int AS n FROM course_videos')).rows[0].n;
  assert.ok(r.videos <= all);
  assert.ok(!('revenue' in r), 'money figures are never public');
});

test('store: courses list shows published courses only and nothing private', async () => {
  const r = await (await fetch(`${base}/api/store/courses`)).json();
  const published = (await pool.query('SELECT COUNT(*)::int AS n FROM courses WHERE is_published')).rows[0].n;
  assert.strictEqual(r.data.length, published);
  assert.ok(r.data.every((c) => c.title && typeof c.price === 'number' && typeof c.videos === 'number'));
  const keys = new Set(r.data.flatMap((c) => Object.keys(c)));
  for (const secret of ['revenue', 'video_url', 'is_published', 'status']) assert.ok(!keys.has(secret), `${secret} must not be public`);
  const draft = (await pool.query('SELECT title FROM courses WHERE NOT is_published LIMIT 1')).rows[0];
  if (draft) assert.ok(!r.data.some((c) => c.title === draft.title), 'a draft course is hidden');
});

test('store: one course shows its syllabus but no video links, and drafts stay hidden', async () => {
  const pub = (await pool.query('SELECT id FROM courses WHERE is_published ORDER BY id LIMIT 1')).rows[0];
  const r = await (await fetch(`${base}/api/store/courses/${pub.id}`)).json();
  assert.ok(r.course.title && r.sections.length > 0 && r.sections.every((s) => Array.isArray(s.videos)));
  assert.strictEqual(r.course.videos, r.sections.reduce((n, s) => n + s.videos.length, 0));
  const text = JSON.stringify(r);
  const links = text.match(/https?:[^"]*\.m3u8/g) || [];
  assert.ok(links.length <= 1, 'at most one video link (the free preview) is ever public');
  if (r.preview) assert.ok(/m3u8|mp4/.test(r.preview.url) && r.preview.title);
  for (const secret of ['video_url', 'bunny_video_id', 'download_url', 'revenue', 'is_published']) assert.ok(!text.includes(secret), `${secret} must not be public`);
  const draft = (await pool.query('SELECT id FROM courses WHERE NOT is_published LIMIT 1')).rows[0];
  if (draft) assert.strictEqual((await fetch(`${base}/api/store/courses/${draft.id}`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/store/courses/999999999`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/store/courses/abc`)).status, 404);
});

test('store: course pictures get a fresh signed link that really loads', async () => {
  const list = await (await fetch(`${base}/api/store/courses`)).json();
  const withPic = list.data.find((c) => c.thumbnail_url && c.thumbnail_url.includes('X-Amz-Signature'));
  if (!withPic) return; // nothing signed to check on this database
  const stored = (await pool.query('SELECT thumbnail_url FROM courses WHERE id = $1', [withPic.id])).rows[0].thumbnail_url;
  assert.notStrictEqual(withPic.thumbnail_url, stored, 'the old expired link is replaced');
  const head = await fetch(withPic.thumbnail_url, { headers: { Range: 'bytes=0-1023' } }); // a signed link works for GET only
  assert.ok([200, 206].includes(head.status), `the fresh link opens (got ${head.status})`);
  assert.match(head.headers.get('content-type') || '', /^image\//);
  const detail = await (await fetch(`${base}/api/store/courses/${withPic.id}`)).json();
  assert.ok(detail.course.thumbnail_url.includes('X-Amz-Signature'));
});

test('store: a Full Set shows as separate pictures, free images download without login, a bought Full Set downloads as a zip', async () => {
  // Full Set keeps several picture links in one field: the shop must split them
  const fs = await (await fetch(`${base}/api/store/designs?category=full_set&limit=20`)).json();
  assert.ok(fs.data.every((d) => d.image_url && !/\s/.test(d.image_url)), 'image_url is one single link');
  const multi = fs.data.find((d) => d.images.length > 1);
  assert.ok(multi && multi.images[0] === multi.image_url, 'the parts are listed, the first one is the card picture');
  const butta = await (await fetch(`${base}/api/store/designs?category=butta&limit=2`)).json();
  assert.ok(butta.data.every((d) => d.images.length === 1 && d.images[0] === d.image_url));

  // free image: no login, only designs priced 0
  const free = (await pool.query('SELECT id FROM free_image_designs WHERE final_price = 0 ORDER BY id LIMIT 1')).rows[0];
  const dl = await fetch(`${base}/api/store/free/${free.id}/download`);
  assert.strictEqual(dl.status, 200);
  assert.match(dl.headers.get('content-disposition'), /^attachment; filename="free-design-\d+\.bmp"$/);
  assert.ok((await dl.arrayBuffer()).byteLength > 1000);
  assert.strictEqual((await fetch(`${base}/api/store/free/999999999/download`)).status, 404);
  assert.strictEqual((await fetch(`${base}/api/store/free/abc/download`)).status, 404);

  // a bought Full Set with several original files comes as one zip
  const { signToken } = require('../src/auth');
  const u = (await pool.query("INSERT INTO users (email, password_hash, full_name) VALUES ('tmp-zip-shopper@example.com', 'x', 'Zip Tester') RETURNING customer_id")).rows[0].customer_id;
  try {
    const set = (await pool.query("SELECT id, name, split_part(btrim(image_url), ' ', 1) AS img FROM full_set_designs WHERE original_image_url LIKE '% %' ORDER BY id LIMIT 1")).rows[0];
    const o = (await pool.query("INSERT INTO orders (customer_id, mobile_number, items_total, platform_fee, total, payment_status, razorpay_order_id, razorpay_payment_id) VALUES ($1,'1',100,0,100,'captured','order_TMPZIP','pay_TMPZIP') RETURNING id", [u])).rows[0].id;
    const item = (await pool.query("INSERT INTO order_items (order_id, position, design_id, design_category, design_name, image_url, price, final_price) VALUES ($1,1,$2,'full_set',$3,$4,100,100) RETURNING id", [o, set.id, set.name, set.img])).rows[0].id;
    const auth = { Authorization: `Bearer ${signToken(u)}` };
    const list = await (await fetch(`${base}/api/store/purchases`, { headers: auth })).json();
    assert.ok(list.data[0].files > 1 && !/\s/.test(list.data[0].image_url), 'the page gets one picture and the number of files');
    const zip = await fetch(`${base}/api/store/purchases/${item}/download`, { headers: auth });
    assert.strictEqual(zip.status, 200);
    assert.match(zip.headers.get('content-disposition'), /\.zip"$/);
    const bytes = Buffer.from(await zip.arrayBuffer());
    assert.strictEqual(bytes.subarray(0, 2).toString(), 'PK', 'it is a real zip file');
    const { unzipSync } = require('fflate');
    assert.strictEqual(Object.keys(unzipSync(new Uint8Array(bytes))).length, list.data[0].files);
  } finally {
    await pool.query('DELETE FROM orders WHERE customer_id = $1', [u]);
    await pool.query('DELETE FROM users WHERE customer_id = $1', [u]);
  }
});

test('designs: a Full Set can be created with several pictures, other styles stay at one', async () => {
  const json = { 'Content-Type': 'application/json' };
  const designer = (await pool.query("SELECT email FROM designers WHERE status = 'active' ORDER BY id LIMIT 1")).rows[0].email;
  const A = 'https://example.com/a.bmp';
  const B = 'https://example.com/b.bmp';
  const base1 = { name: 'TMPFS', designer_email: designer, jacquard_type: 'powerloom', ppi: 68, body_epi: 100, image_type: 'BMP', listing_rate: 10, final_price: 5 };
  const made = [];
  try {
    const ok = await fetch(`${base}/api/designs/full_set`, { method: 'POST', headers: json, body: JSON.stringify({ ...base1, image_url: `${A}  ${B}`, original_image_url: `${A} ${B}` }) });
    assert.strictEqual(ok.status, 201);
    const row = await ok.json(); made.push(row.id);
    assert.strictEqual(row.image_url, `${A} ${B}`, 'extra spaces are tidied');
    assert.strictEqual((await fetch(`${base}/api/designs/full_set`, { method: 'POST', headers: json, body: JSON.stringify({ ...base1, image_url: `${A} nope`, original_image_url: A }) })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/designs/full_set`, { method: 'POST', headers: json, body: JSON.stringify({ ...base1, image_url: Array(21).fill(A).join(' '), original_image_url: A }) })).status, 400);
    // a Butta still takes one link only
    const weave = { name: 'TMPBU', designer_email: designer, cards: 1, hooks: 1, epi: 1, ppi: 1, image_type: 'BMP', listing_rate: 1, final_price: 1 };
    const r2 = await fetch(`${base}/api/designs/butta`, { method: 'POST', headers: json, body: JSON.stringify({ ...weave, image_url: `${A} ${B}`, original_image_url: A }) });
    assert.strictEqual(r2.status, 400);
    if (r2.status === 201) made.push(null);
  } finally {
    for (const id of made.filter(Boolean)) await pool.query('DELETE FROM full_set_designs WHERE id = $1', [id]);
    await pool.query("DELETE FROM full_set_designs WHERE name = 'TMPFS'");
    await pool.query("DELETE FROM butta_designs WHERE name = 'TMPBU'");
  }
});

test('course enrolment: pay for a package, get access to the lessons, others are kept out (fake Razorpay, throwaway users)', async () => {
  const bcrypt = require('bcryptjs');
  const crypto = require('crypto');
  const http = require('http');
  const { signToken } = require('../src/auth');
  const json = { 'Content-Type': 'application/json' };
  let lastOrder;
  const fake = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => { lastOrder = JSON.parse(raw); res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ id: `order_TMPK${Date.now()}${Math.floor(Math.random() * 1000)}`, amount: lastOrder.amount })); });
  });
  await new Promise((r) => fake.listen(0, r));
  const saved = { b: process.env.RAZORPAY_API_BASE, s: process.env.RAZORPAY_KEY_SECRET, k: process.env.RAZORPAY_KEY_ID };
  process.env.RAZORPAY_API_BASE = `http://localhost:${fake.address().port}`;
  process.env.RAZORPAY_KEY_SECRET = 'tmp_test_secret';
  process.env.RAZORPAY_KEY_ID = 'rzp_test_TMP';
  const mk = async (email) => (await pool.query("INSERT INTO users (email, password_hash, full_name, phone) VALUES ($1, $2, 'Tmp Student', '9000000000') RETURNING customer_id", [email, bcrypt.hashSync('x', 4)])).rows[0].customer_id;
  const buyer = await mk('tmp-enrol-buyer@example.com');
  const outsider = await mk('tmp-enrol-outsider@example.com');
  const course = (await pool.query('SELECT id, price::float AS price, certificate_with_price::float AS cert FROM courses WHERE is_published ORDER BY id LIMIT 1')).rows[0];
  try {
    const A = { ...json, Authorization: `Bearer ${signToken(buyer)}` };
    const O = { ...json, Authorization: `Bearer ${signToken(outsider)}` };
    const checkout = (pack, h = A) => fetch(`${base}/api/store/courses/${course.id}/checkout`, { method: 'POST', headers: h, body: JSON.stringify({ package: pack }) });

    // the public course lists the packages, priced by the server
    const pub = await (await fetch(`${base}/api/store/courses/${course.id}`)).json();
    assert.deepStrictEqual(pub.packages.map((p) => p.key), ['basic', 'standard', 'pro', 'elite']);
    assert.strictEqual(pub.packages[0].price, course.price);
    assert.strictEqual(pub.packages[1].price, course.cert);

    assert.strictEqual((await checkout('basic', json)).status, 401);
    assert.strictEqual((await checkout('platinum')).status, 400);
    assert.strictEqual((await fetch(`${base}/api/store/courses/999999999/checkout`, { method: 'POST', headers: A, body: JSON.stringify({ package: 'basic' }) })).status, 404);
    for (const p of pub.packages) {
      const r = await checkout(p.key);
      assert.strictEqual(r.status, 200);
      assert.strictEqual((await r.json()).total, p.price, `${p.key} is charged what the server says`);
      assert.strictEqual(lastOrder.amount, Math.round(p.price * 100));
    }
    // pay for Pro
    const pro = await (await checkout('pro')).json();
    const pay = `pay_TMPK${Date.now()}`;
    const sig = (o, p) => crypto.createHmac('sha256', 'tmp_test_secret').update(`${o}|${p}`).digest('hex');
    const verify = (body, h = A) => fetch(`${base}/api/store/courses/checkout/verify`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.strictEqual((await verify({ razorpay_order_id: pro.orderId, razorpay_payment_id: pay, razorpay_signature: 'f'.repeat(64) })).status, 400);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM enrollments WHERE customer_id = $1', [buyer])).rows[0].n, 0, 'a bad signature enrols nobody');
    assert.strictEqual((await verify({ razorpay_order_id: pro.orderId, razorpay_payment_id: pay, razorpay_signature: sig(pro.orderId, pay) }, O)).status, 404, 'another shopper cannot confirm it');
    const ok = await verify({ razorpay_order_id: pro.orderId, razorpay_payment_id: pay, razorpay_signature: sig(pro.orderId, pay) });
    assert.strictEqual(ok.status, 200);
    const { enrollmentId, courseId } = await ok.json();
    assert.strictEqual(String(courseId), String(course.id));
    const row = (await pool.query('SELECT payment_status, amount_paid::float AS a, certificate_included, doubt_support_included, expires_at > NOW() AS live FROM enrollments WHERE id = $1', [enrollmentId])).rows[0];
    assert.deepStrictEqual([row.payment_status, row.a, row.certificate_included, row.doubt_support_included, row.live], ['completed', pub.packages[2].price, true, true, true]);
    const again = await (await verify({ razorpay_order_id: pro.orderId, razorpay_payment_id: pay, razorpay_signature: sig(pro.orderId, pay) })).json();
    assert.ok(again.already && again.enrollmentId === enrollmentId, 'confirming twice enrols once');
    // the design checkout cannot be used to confirm a course payment
    const dsg = await fetch(`${base}/api/store/checkout/verify`, { method: 'POST', headers: A, body: JSON.stringify({ razorpay_order_id: pro.orderId, razorpay_payment_id: 'pay_X', razorpay_signature: sig(pro.orderId, 'pay_X') }) });
    assert.ok([404, 400].includes(dsg.status));
    assert.strictEqual((await checkout('basic')).status, 409, 'cannot buy a course twice while enrolled');

    // access
    assert.strictEqual((await (await fetch(`${base}/api/store/courses/${course.id}/access`, { headers: A })).json()).enrolled, true);
    assert.strictEqual((await (await fetch(`${base}/api/store/courses/${course.id}/access`, { headers: O })).json()).enrolled, false);
    const mine = await (await fetch(`${base}/api/store/enrollments/${enrollmentId}`, { headers: A })).json();
    assert.deepStrictEqual([mine.package, mine.amount, mine.course_id], ['Pro', pub.packages[2].price, String(course.id)]);
    assert.strictEqual((await fetch(`${base}/api/store/enrollments/${enrollmentId}`, { headers: O })).status, 404, 'not someone else\'s enrolment');
    const learn = await fetch(`${base}/api/store/learn/${course.id}`, { headers: A });
    assert.strictEqual(learn.status, 200);
    const body = await learn.json();
    assert.ok(body.sections.length > 0 && body.sections[0].videos[0].url, 'the enrolled student gets the lessons with their video links');
    // the course's software, with download links, is for enrolled students only
    assert.ok(Array.isArray(body.software) && body.software.length > 0 && body.software.every((x) => x.name && x.download_url), 'the student gets the software with its download links');
    assert.ok(!JSON.stringify(pub).includes('drive.google.com') && !JSON.stringify(pub.software || []).includes('download_url'), 'the public course page never shows the download links');

    // ---- progress: a lesson is done at 60%, then the next one opens ----
    const flat = body.sections.flatMap((s) => s.videos);
    assert.ok(flat[0].locked === false && flat[0].url, 'the first lesson is open');
    assert.ok(flat[1].locked === true && flat[1].url === null, 'the second lesson is locked and has no video link');
    assert.deepStrictEqual([body.progress.completed, body.progress.percent], [0, 0]);
    const postProgress = (vid, pos, h = A) => fetch(`${base}/api/store/learn/${course.id}/progress`, { method: 'POST', headers: h, body: JSON.stringify({ video_id: Number(vid), position_seconds: pos, duration_seconds: 100 }) });
    assert.strictEqual((await postProgress(flat[1].id, 50)).status, 403, 'a locked lesson cannot be marked watched');
    assert.strictEqual((await postProgress(flat[0].id, 50, O)).status, 403, 'not enrolled');
    const dur0 = flat[0].duration_seconds;
    const first = await (await postProgress(flat[0].id, dur0)).json();   // claiming the whole video at once
    assert.ok(first.watched_percent < 60 && first.done === false, 'jumping straight to the end earns nothing: playback has to take time');
    await pool.query("UPDATE enrollment_video_progress SET last_played_at = NOW() - INTERVAL '200 seconds' WHERE enrollment_id = $1", [enrollmentId]);
    const second = await (await postProgress(flat[0].id, Math.ceil(dur0 * 0.65))).json();
    assert.strictEqual(second.done, true, '65% watched over enough time completes the lesson');
    assert.strictEqual(second.next_unlocked, true);
    assert.deepStrictEqual([second.progress.completed, second.progress.percent], [1, Math.round(100 / flat.length)]);
    const reopened = (await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).sections.flatMap((s) => s.videos);
    assert.ok(reopened[0].done && reopened[1].locked === false && reopened[1].url && reopened[2].locked === true);
    assert.strictEqual((await pool.query('SELECT progress_percentage FROM enrollments WHERE id = $1', [enrollmentId])).rows[0].progress_percentage, Math.round(100 / flat.length), 'the admin figure follows');
    // ---- doubt support: the Pro package has it ----
    const asker = (body, h = A) => fetch(`${base}/api/store/learn/${course.id}/doubts`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/doubts`)).status, 401);
    assert.strictEqual((await asker({ question: 'How do I start?' }, O)).status, 403, 'not enrolled: cannot ask');
    assert.strictEqual((await asker({ question: 'hi' })).status, 400, 'too short');
    assert.strictEqual((await asker({ question: 'x'.repeat(1001) })).status, 400, 'too long');
    assert.strictEqual((await asker({ question: 'Which lesson is this?', video_id: 999999999 })).status, 400, 'a lesson from elsewhere is refused');
    assert.strictEqual((await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).doubt_support, true);
    const q1 = await asker({ question: '  How do I tie the harness for 600 hooks?  ', video_id: flat[0].id });
    assert.strictEqual(q1.status, 201);
    const made = await q1.json();
    assert.deepStrictEqual([made.status, made.answer, made.lesson], ['pending', null, flat[0].title]);
    assert.strictEqual(made.question, 'How do I tie the harness for 600 hooks?', 'the question is tidied');
    assert.strictEqual((await asker({ question: 'A question about the whole course' })).status, 201);
    // the admin answers it from the Doubts page; the student sees the answer
    const ans = await fetch(`${base}/api/doubts/${made.id}/answer`, { method: 'PUT', headers: json, body: JSON.stringify({ answer: 'Tie the front hooks first.' }) });
    assert.ok([200, 204].includes(ans.status), `answering works (got ${ans.status})`);
    const listed = await (await fetch(`${base}/api/store/learn/${course.id}/doubts`, { headers: A })).json();
    assert.strictEqual(listed.data.length, 2);
    const mineQ = listed.data.find((d) => String(d.id) === String(made.id));
    assert.deepStrictEqual([mineQ.status, mineQ.answer], ['answered', 'Tie the front hooks first.']);
    assert.strictEqual((await (await fetch(`${base}/api/store/learn/${course.id}/doubts`, { headers: O })).json()).data, undefined, 'another student never sees them');
    // a package without doubt support
    await pool.query('UPDATE enrollments SET doubt_support_included = FALSE WHERE id = $1', [enrollmentId]);
    assert.strictEqual((await asker({ question: 'Can I still ask?' })).status, 403);
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/doubts`, { headers: A })).status, 403);
    assert.strictEqual((await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).doubt_support, false);
    await pool.query('UPDATE enrollments SET doubt_support_included = TRUE WHERE id = $1', [enrollmentId]);

    // ---- reviewing the course ----
    const putReview = (body, h = A) => fetch(`${base}/api/store/learn/${course.id}/review`, { method: 'PUT', headers: h, body: JSON.stringify(body) });
    assert.strictEqual((await putReview({ rating: 5 }, json)).status, 401);
    assert.strictEqual((await putReview({ rating: 5 }, O)).status, 403, 'only enrolled students can review');
    assert.strictEqual((await putReview({ rating: 0 })).status, 400);
    assert.strictEqual((await putReview({ rating: 4, review: 'x'.repeat(1001) })).status, 400);
    assert.strictEqual((await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).my_review, null);
    assert.strictEqual((await putReview({ rating: 4, review: '  Clear lessons  ' })).status, 200);
    assert.strictEqual((await putReview({ rating: 5, review: 'Even better than I thought' })).status, 200);
    const mineRev = (await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).my_review;
    assert.deepStrictEqual([mineRev.rating, mineRev.review_text], [5, 'Even better than I thought']);
    assert.strictEqual((await pool.query('SELECT COUNT(*)::int AS n FROM course_reviews WHERE customer_id = $1', [buyer])).rows[0].n, 1, 'editing never makes a second review');
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}`, { headers: O })).status, 403, 'not enrolled: no lessons');
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}`)).status, 401);
    assert.strictEqual((await (await fetch(`${base}/api/store/learn`, { headers: A })).json()).data.length, 1);
    // ---- certificate: request at 80%, the instructor approves, the student downloads ----
    const certReq = (body, h = A) => fetch(`${base}/api/store/learn/${course.id}/certificate`, { method: 'POST', headers: h, body: JSON.stringify(body) });
    const goodReq = { title: 'Ms.', full_name: 'Priya Lakshmi', delivery_email: 'priya@example.com' };
    const certInfo = async () => (await (await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).json()).certificate;
    const before = await certInfo();
    assert.deepStrictEqual([before.required, before.eligible, before.status], [80, false, null], 'a Pro package has a certificate, not yet allowed');
    assert.strictEqual((await certReq(goodReq)).status, 403, 'under 80% finished: no request');
    // finish 80% of the lessons
    const need = Math.ceil(flat.length * 0.8);
    for (const v of flat.slice(0, need)) await pool.query('INSERT INTO enrollment_video_progress (enrollment_id, video_id, duration_seconds, position_seconds, max_position_seconds, last_played_at, is_completed) VALUES ($1,$2,100,100,100,NOW(),TRUE) ON CONFLICT (enrollment_id, video_id) DO UPDATE SET is_completed = TRUE', [enrollmentId, v.id]);
    assert.strictEqual((await certInfo()).eligible, true, 'at 80% the certificate can be requested');
    assert.strictEqual((await certReq(goodReq, json)).status, 401);
    assert.strictEqual((await certReq(goodReq, O)).status, 403, 'not enrolled');
    assert.strictEqual((await certReq({ ...goodReq, title: 'Lord' })).status, 400);
    assert.strictEqual((await certReq({ ...goodReq, full_name: 'பிரியா' })).status, 400, 'only English letters are printed');
    assert.strictEqual((await certReq({ ...goodReq, full_name: 'A' })).status, 400);
    assert.strictEqual((await certReq({ ...goodReq, delivery_email: 'not-an-email' })).status, 400);
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/certificate/download`, { headers: A })).status, 404, 'nothing to download before approval');
    const requested = await certReq({ ...goodReq, full_name: '  Priya   Lakshmi ' });
    assert.strictEqual(requested.status, 201);
    assert.deepStrictEqual([(await requested.json()).status, (await certInfo()).status, (await certInfo()).full_name], ['requested', 'requested', 'Priya Lakshmi']);
    assert.strictEqual((await certReq(goodReq)).status, 409, 'one request per enrolment');
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/certificate/download`, { headers: A })).status, 404, 'still waiting for the instructor');
    // the instructor approves it in the admin
    const upload = (name, bytes, type) => { const f = new FormData(); f.append('file', new Blob([bytes], { type }), name); return f; };
    const PDF = Buffer.from('%PDF-1.4\n% a tiny test certificate\n%%EOF\n');
    assert.strictEqual((await fetch(`${base}/api/certificates/999999999/issue`, { method: 'PUT', body: upload('c.pdf', PDF, 'application/pdf') })).status, 404);
    assert.strictEqual((await fetch(`${base}/api/certificates/${enrollmentId}/issue`, { method: 'PUT' })).status, 400, 'a file is required to approve');
    assert.strictEqual((await fetch(`${base}/api/certificates/${enrollmentId}/issue`, { method: 'PUT', body: upload('c.pdf', Buffer.from('this is not a pdf'), 'application/pdf') })).status, 400, 'a fake PDF is refused');
    assert.strictEqual((await fetch(`${base}/api/certificates/${enrollmentId}/issue`, { method: 'PUT', body: upload('c.exe', PDF, 'application/octet-stream') })).status, 400, 'wrong file type');
    assert.strictEqual((await certInfo()).status, 'requested', 'refused uploads change nothing');
    const issued = await fetch(`${base}/api/certificates/${enrollmentId}/issue`, { method: 'PUT', body: upload('my certificate.pdf', PDF, 'application/pdf') });
    assert.strictEqual(issued.status, 200);
    const issuedBody = await issued.json();
    assert.ok(issuedBody.status === 'issued' && /^CERT-\d+-\d+$/.test(issuedBody.certificate_number));
    assert.strictEqual((await fetch(`${base}/api/certificates/${enrollmentId}/issue`, { method: 'PUT', body: upload('c.pdf', PDF, 'application/pdf') })).status, 409, 'cannot be issued twice');
    const info = await certInfo();
    assert.deepStrictEqual([info.status, info.certificate_number], ['issued', issuedBody.certificate_number]);
    const pdf = await fetch(`${base}/api/store/learn/${course.id}/certificate/download`, { headers: A });
    assert.strictEqual(pdf.status, 200);
    assert.strictEqual(pdf.headers.get('content-type'), 'application/pdf');
    assert.match(pdf.headers.get('content-disposition'), /^attachment; filename="CERT-\d+-\d+\.pdf"$/);
    const got = Buffer.from(await pdf.arrayBuffer());
    assert.ok(got.equals(PDF), 'the student downloads exactly the file the instructor uploaded');
    const stored = (await pool.query('SELECT certificate_url FROM certificates WHERE enrollment_id = $1', [enrollmentId])).rows[0].certificate_url;
    assert.match(stored, /^s3:\/\/[^/]+\/certificates\/\d+-\d+\.pdf$/, 'saved in S3 under certificates/');
    const adminFile = await fetch(`${base}/api/certificates/${enrollmentId}/file`);
    assert.strictEqual(adminFile.status, 200);
    assert.ok(Buffer.from(await adminFile.arrayBuffer()).equals(PDF), 'the admin can open the same file');
    const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from('PNG\r\n\x1a\n'), Buffer.alloc(20)]);
    assert.strictEqual((await fetch(`${base}/api/certificates/${enrollmentId}/file`, { method: 'PUT', body: upload('new.png', PNG, 'image/png') })).status, 200, 'the file can be replaced');
    const png = await fetch(`${base}/api/store/learn/${course.id}/certificate/download`, { headers: A });
    assert.match(png.headers.get('content-disposition'), /\.png"$/);
    assert.ok(Buffer.from(await png.arrayBuffer()).equals(PNG));
    await new Promise((r) => setTimeout(r, 200));
    // clean-up: the first file went when it was replaced; remove the second (the test's own file) from S3 too
    const finalRef = (await pool.query('SELECT certificate_url FROM certificates WHERE enrollment_id = $1', [enrollmentId])).rows[0].certificate_url;
    await require('../src/s3').deletePrivate(finalRef).catch(() => {});
    await require('../src/s3').deletePrivate(stored).catch(() => {});
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/certificate/download`, { headers: O })).status, 404, 'not someone else\'s certificate');
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}/certificate/download`)).status, 401);
    // a package without a certificate gets none of this
    await pool.query('UPDATE enrollments SET certificate_included = FALSE WHERE id = $1', [enrollmentId]);
    assert.strictEqual((await certInfo()), null, 'no certificate section for a package without one');
    await pool.query('UPDATE enrollments SET certificate_included = TRUE WHERE id = $1', [enrollmentId]);

    // access ends with the expiry date
    await pool.query("UPDATE enrollments SET expires_at = NOW() - INTERVAL '1 day' WHERE id = $1", [enrollmentId]);
    assert.strictEqual((await fetch(`${base}/api/store/learn/${course.id}`, { headers: A })).status, 403, 'expired access is closed');
  } finally {
    await pool.query('DELETE FROM course_doubts WHERE customer_id = ANY($1::bigint[])', [[buyer, outsider]]);
    await pool.query('DELETE FROM course_reviews WHERE customer_id = ANY($1::bigint[])', [[buyer, outsider]]);
    await pool.query('DELETE FROM enrollments WHERE customer_id = ANY($1::bigint[])', [[buyer, outsider]]);
    await pool.query('DELETE FROM checkout_sessions WHERE customer_id = ANY($1::bigint[])', [[buyer, outsider]]);
    await pool.query('DELETE FROM users WHERE customer_id = ANY($1::bigint[])', [[buyer, outsider]]);
    fake.close();
    for (const [k, v] of [['RAZORPAY_API_BASE', saved.b], ['RAZORPAY_KEY_SECRET', saved.s], ['RAZORPAY_KEY_ID', saved.k]]) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
