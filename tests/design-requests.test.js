const { test, before, after } = require('node:test');
const assert = require('node:assert');
const app = require('../src/app');
const pool = require('../src/db');
const s3 = require('../src/s3');

let server; let base;
before(() => { server = app.listen(0); base = `http://localhost:${server.address().port}`; });
after(async () => { server.close(); await pool.end(); });

// a 1x1 PNG
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const form = (fields, files = []) => {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.append(k, v);
  for (const [name, buf] of files) f.append('images', new Blob([buf]), name);
  return f;
};
const GOOD = { name: 'Tmp Requester', email: 'tmp-request@example.com', phone: '+91 98765 43210', requirement: 'I need a pallu design with peacocks and a zari border.', notes: 'Wedding saree', source: 'app' };

test('design requests: validation, pictures, admin list and status, delete', async () => {
  const ids = [];
  try {
    // bad details are refused
    for (const [bad, field] of [[{ name: '' }, 'name'], [{ email: 'nope' }, 'email'], [{ phone: '12' }, 'phone'], [{ requirement: 'short' }, 'requirement']]) {
      const r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form({ ...GOOD, ...bad }) });
      assert.strictEqual(r.status, 400);
      assert.ok((await r.json()).fields[field], `${field} is checked`);
    }
    // a text file renamed to .png is refused (checked by its first bytes)
    let r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form(GOOD, [['fake.png', Buffer.from('this is not a picture')]]) });
    assert.strictEqual(r.status, 400);
    // a third picture is refused
    r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form(GOOD, [['a.png', PNG], ['b.png', PNG], ['c.png', PNG]]) });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /at most 2/);
    // a picture over 5 MB is refused
    r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form(GOOD, [['big.png', Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 10)])]]) });
    assert.strictEqual(r.status, 400);
    assert.match((await r.json()).error, /5 MB/);

    // a good request with two pictures
    r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form(GOOD, [['a.png', PNG], ['b.png', PNG]]) });
    assert.strictEqual(r.status, 201);
    const { id } = await r.json();
    ids.push(id);

    // the admin sees it, with the number of pictures, and can open each one
    const list = await (await fetch(`${base}/api/design-requests?search=tmp-request&status=new`)).json();
    const row = list.data.find((x) => x.id === id);
    assert.ok(row);
    assert.strictEqual(row.image_count, 2);
    assert.strictEqual(row.status, 'new');
    assert.strictEqual(row.source, 'app');
    assert.ok(!('images' in row), 'private storage references are not exposed');
    for (const n of [1, 2]) {
      const img = await fetch(`${base}/api/design-requests/${id}/images/${n}`);
      assert.strictEqual(img.status, 200);
      assert.strictEqual(img.headers.get('content-type'), 'image/png');
      assert.deepStrictEqual(Buffer.from(await img.arrayBuffer()), PNG);
    }
    assert.strictEqual((await fetch(`${base}/api/design-requests/${id}/images/3`)).status, 404);

    // a request without pictures works too
    r = await fetch(`${base}/api/store/design-requests`, { method: 'POST', body: form({ ...GOOD, source: 'web' }) });
    assert.strictEqual(r.status, 201);
    ids.push((await r.json()).id);

    // status and note
    const bad = await fetch(`${base}/api/design-requests/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'weird' }) });
    assert.strictEqual(bad.status, 400);
    const upd = await (await fetch(`${base}/api/design-requests/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'contacted', admin_note: 'Called, quote sent' }) })).json();
    assert.strictEqual(upd.status, 'contacted');
    assert.strictEqual(upd.admin_note, 'Called, quote sent');
    const sum = await (await fetch(`${base}/api/design-requests/summary`)).json();
    assert.ok(sum.contacted >= 1 && sum.new >= 1 && sum.total >= 2);

    // delete removes the row and its pictures
    const refs = (await pool.query('SELECT images FROM design_requests WHERE id = $1', [id])).rows[0].images;
    assert.strictEqual((await fetch(`${base}/api/design-requests/${id}`, { method: 'DELETE' })).status, 204);
    assert.strictEqual((await fetch(`${base}/api/design-requests/${id}`, { method: 'DELETE' })).status, 404);
    assert.strictEqual(refs.length, 2);
    for (const ref of refs) assert.ok(!(await s3.getPrivate(ref).catch(() => null)), 'picture removed from storage');
    ids.shift();
  } finally {
    for (const id of ids) {
      const row = (await pool.query('DELETE FROM design_requests WHERE id = $1 RETURNING images', [id])).rows[0];
      for (const ref of row?.images || []) await s3.deletePrivate(ref).catch(() => {});
    }
    await pool.query("DELETE FROM design_requests WHERE email = 'tmp-request@example.com'");
  }
});
