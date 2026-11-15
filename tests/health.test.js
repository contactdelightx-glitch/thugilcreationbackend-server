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
  assert.strictEqual(all.total, 194);
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
  assert.strictEqual((await get(`/api/orders?limit=10&offset=194`)).hasMore, false);

  // search + status
  const one = await get('/api/orders?search=pay_T3pN');
  assert.ok(one.total >= 1 && one.data.some((o) => o.id === '151'));
  assert.strictEqual((await get('/api/orders?status=captured')).total, 194);
  assert.strictEqual((await get('/api/orders?status=failed')).total, 0);
  assert.strictEqual((await get('/api/orders?search=zzzz-nothing')).total, 0);

  // summary agrees with the data
  const s = await get('/api/orders/summary');
  assert.strictEqual(s.orders, 194);
  assert.strictEqual(s.itemsSold, 510);
  assert.strictEqual(s.revenue, 62797);
  assert.strictEqual(s.fees, 280);

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
  assert.strictEqual(sum, 194);

  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=2026-13`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=abc`)).status, 400);
  assert.strictEqual((await fetch(`${base}/api/orders/trends?month=2999-01`)).status, 400);
});

test('students: only people who purchased a course are listed', async () => {
  const get = async (path) => (await fetch(`${base}${path}`)).json();

  const sum = await get('/api/students/summary');
  assert.strictEqual(sum.students, 12); // not the 27 registered learners
  assert.strictEqual(sum.enrollments, 12);
  assert.strictEqual(sum.revenue, 110988);
  assert.strictEqual(sum.certificatesIssued, 2);
  assert.strictEqual(sum.certificatesIncluded, 6);
  assert.strictEqual(sum.completed, 0);

  const all = await get('/api/students?limit=100');
  assert.strictEqual(all.total, 12);
  assert.strictEqual(all.data.length, 12);
  assert.ok(!JSON.stringify(all).includes('password'));
  assert.ok(all.data.every((r) => r.enrollment_id && r.course_title && r.enrollment_count >= 1)); // everyone has a purchase
  assert.ok(new Date(all.data[0].enrolled_at) >= new Date(all.data[11].enrolled_at)); // newest first

  // an account that never bought a course is not a student
  const buyers = new Set(all.data.map((r) => r.customer_id));
  const nonBuyer = (await pool.query('SELECT customer_id FROM users ORDER BY customer_id')).rows.find((r) => !buyers.has(String(r.customer_id)));
  assert.ok(nonBuyer);
  assert.strictEqual((await fetch(`${base}/api/students/${nonBuyer.customer_id}/enrollments`)).status, 404);

  assert.ok((await get('/api/students?search=saree')).total === 12); // matches the course title
  assert.strictEqual((await get('/api/students?search=meena')).total, 1);
  assert.strictEqual((await get('/api/students?search=zzzz-nothing')).total, 0);

  // offset paging has no gaps or repeats
  const a = await get('/api/students?limit=5&offset=0');
  const b = await get('/api/students?limit=5&offset=5');
  const both = await get('/api/students?limit=10&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((r) => r.customer_id), both.data.map((r) => r.customer_id));
  assert.strictEqual((await get('/api/students?limit=10&offset=12')).hasMore, false);

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

  const sum = await get('/api/course-payments/summary');
  assert.strictEqual(sum.payments, 12);
  assert.strictEqual(sum.revenue, 110988);
  assert.strictEqual(sum.average, 9249);
  assert.strictEqual(sum.addOnRevenue, 6000 + 9000); // 6 certificates at 1,000 + 3 doubt support at 3,000
  assert.strictEqual(sum.certificates, 6);
  assert.strictEqual(sum.doubtSupport, 3);

  const all = await get('/api/course-payments?limit=100');
  assert.strictEqual(all.total, 12);
  assert.ok(all.data.every((p) => p.razorpay_payment_id && p.course_title && p.student_email));
  assert.ok(new Date(all.data[0].enrolled_at) >= new Date(all.data[11].enrolled_at)); // newest first
  // every payment adds up: price - discount + certificate + doubt support = paid
  assert.ok(all.data.every((p) => Math.abs(Number(p.base_price) - Number(p.discount_amount) + Number(p.certificate_fee) + Number(p.doubt_support_fee) - Number(p.amount_paid)) < 0.01));
  assert.ok(!JSON.stringify(all).includes('password'));

  assert.strictEqual((await get('/api/course-payments?status=completed')).total, 12);
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
  assert.strictEqual(n, 12);
  assert.strictEqual(revenue, 110988);
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
  assert.strictEqual(sum.students, 12);
  assert.strictEqual(sum.revenue, 110988);
  assert.strictEqual(sum.reviews, 3);
  assert.strictEqual(sum.avgRating, 5);

  const list = await get('/api/courses');
  assert.strictEqual(list.total, 2);
  assert.strictEqual(list.data[0].is_published, true); // published first
  const main = list.data.find((c) => c.id === '2');
  assert.deepStrictEqual([main.sections, main.videos, main.duration_seconds, main.resources, main.students, main.revenue, main.review_count, main.avg_rating],
    [26, 62, 64024, 27, 12, 110988, 3, 5]);
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
  assert.deepStrictEqual([full.course.sections, full.course.videos, full.course.students, full.course.revenue], [26, 62, 12, 110988]);
  assert.strictEqual(full.sections.length, 26);
  assert.ok(full.sections.every((s, i) => i === 0 || s.position > full.sections[i - 1].position)); // in order
  assert.strictEqual(full.sections.reduce((n, s) => n + s.videos.length, 0), 62);
  assert.ok(full.sections.every((s) => s.videos.every((v, i) => i === 0 || v.position > s.videos[i - 1].position)));
  assert.strictEqual(full.sections.reduce((n, s) => n + s.duration_seconds, 0), 64024);
  assert.strictEqual(full.learningPoints.length, 5);
  assert.strictEqual(full.resources.length, 27);
  assert.ok(full.resources.every((r) => r.video_title && r.section_title));
  assert.strictEqual(full.software.length, 1);
  assert.strictEqual(full.reviews.length, 3);
  assert.ok(full.reviews.every((r) => r.reviewer && r.rating === 5));
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

  const sum = await get('/api/certificates/summary');
  assert.deepStrictEqual(sum, { total: 6, issued: 2, requested: 0, notRequested: 4, revenue: 6000 });

  const all = await get('/api/certificates?limit=100');
  assert.strictEqual(all.total, 6);
  assert.ok(all.data.every((r) => r.student_email && r.course_title));
  assert.deepStrictEqual(all.data.map((r) => r.status), ['issued', 'issued', 'not_requested', 'not_requested', 'not_requested', 'not_requested']); // issued before not requested
  const issued = all.data.filter((r) => r.status === 'issued');
  assert.ok(issued.every((r) => r.certificate_number.startsWith('CERT-') && r.certificate_url && r.issued_at && r.name_on_certificate && r.delivery_email));
  assert.ok(all.data.filter((r) => r.status === 'not_requested').every((r) => !r.certificate_number && !r.certificate_url && r.certificate_fee === 1000));

  assert.strictEqual((await get('/api/certificates?status=issued')).total, 2);
  assert.strictEqual((await get('/api/certificates?status=not_requested')).total, 4);
  assert.strictEqual((await get('/api/certificates?status=requested')).total, 0);
  assert.strictEqual((await get(`/api/certificates?search=${issued[0].certificate_number}`)).total, 1);
  assert.strictEqual((await get('/api/certificates?search=zzzz-nothing')).total, 0);
  assert.strictEqual((await get('/api/certificates?search=saree')).total, 6); // matches the course title

  const a = await get('/api/certificates?limit=2&offset=0');
  const b = await get('/api/certificates?limit=2&offset=2');
  const both = await get('/api/certificates?limit=4&offset=0');
  assert.deepStrictEqual([...a.data, ...b.data].map((r) => r.enrollment_id), both.data.map((r) => r.enrollment_id));
  assert.strictEqual((await get('/api/certificates?limit=10&offset=6')).hasMore, false);
});
