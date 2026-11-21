const { test, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const crypto = require('node:crypto');

// a fake Bunny Stream: it records what it is asked
const calls = [];
const videos = new Map(); // guid -> { status, encodeProgress, length }
const bunny = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    calls.push({ method: req.method, url: req.url, key: req.headers.accesskey, body: body ? JSON.parse(body) : null });
    const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === null ? '' : JSON.stringify(obj)); };
    const u = req.url.replace('/library/777', '');
    if (req.method === 'GET' && u.startsWith('/collections')) return send(200, { items: [] });
    if (req.method === 'POST' && u === '/collections') return send(200, { guid: 'col-1' });
    if (req.method === 'POST' && u === '/videos') { const guid = crypto.randomUUID(); videos.set(guid, { status: 0, encodeProgress: 0, length: 0 }); return send(200, { guid }); }
    const m = /^\/videos\/([^/?]+)$/.exec(u);
    if (m && req.method === 'GET') return videos.has(m[1]) ? send(200, { ...videos.get(m[1]), availableResolutions: 'v240p,v720p' }) : send(404, {});
    send(404, {});
  });
});

let app; let pool; let server; let base;
before(async () => {
  await new Promise((r) => bunny.listen(0, r));
  Object.assign(process.env, { BUNNY_API_BASE: `http://localhost:${bunny.address().port}`, BUNNY_STREAM_API_KEY: 'secret-key', BUNNY_LIBRARY_ID: '777', BUNNY_CDN_URL: 'https://cdn.example.net/', BUNNY_TUS_ENDPOINT: 'https://tus.example.net/tusupload' });
  app = require('../src/app'); pool = require('../src/db');
  server = app.listen(0); base = `http://localhost:${server.address().port}`;
});
after(async () => { server.close(); bunny.close(); await pool.end(); });

const json = { 'Content-Type': 'application/json' };
const base_ = { title: 'TMP BUNNY UPLOAD TEST', instructor_name: 'T', price: 10 }; // a course save always carries these
const call = (path, method = 'GET', body) => fetch(`${base}${path}`, { method, headers: json, body: body ? JSON.stringify(body) : undefined });

test('upload start: creates the video on Bunny and signs the direct upload', async () => {
  calls.length = 0;
  assert.strictEqual((await call('/api/courses/videos/upload', 'POST', { title: '  ' })).status, 400);
  const r = await call('/api/courses/videos/upload', 'POST', { title: 'Lesson 1' });
  assert.strictEqual(r.status, 201);
  const out = await r.json();
  assert.match(out.bunny_video_id, /^[0-9a-f-]{36}$/);
  // the signature is sha256(libraryId + apiKey + expires + videoId), the way Bunny checks it
  const expect = crypto.createHash('sha256').update(`777secret-key${out.tus.expires}${out.bunny_video_id}`).digest('hex');
  assert.strictEqual(out.tus.signature, expect);
  assert.deepStrictEqual([out.tus.endpoint, out.tus.libraryId, out.tus.videoId], ['https://tus.example.net/tusupload', '777', out.bunny_video_id]);
  assert.ok(out.tus.expires > Date.now() / 1000 + 3600);
  assert.ok(!JSON.stringify(out).includes('secret-key'), 'the API key never reaches the browser');
  const made = calls.find((c) => c.method === 'POST' && c.url.endsWith('/videos'));
  assert.strictEqual(made.key, 'secret-key');
  assert.deepStrictEqual(made.body, { title: 'Lesson 1', collectionId: 'col-1' });
  videos.delete(out.bunny_video_id);
});

test('status: maps Bunny states and gives the links once it is ready', async () => {
  const id = crypto.randomUUID();
  videos.set(id, { status: 1, encodeProgress: 0, length: 0 });
  assert.strictEqual((await (await call(`/api/courses/videos/bunny/${id}`)).json()).status, 'uploaded');
  videos.set(id, { status: 3, encodeProgress: 42, length: 0 });
  const mid = await (await call(`/api/courses/videos/bunny/${id}`)).json();
  assert.deepStrictEqual([mid.status, mid.progress], ['processing', 42]);
  videos.set(id, { status: 4, encodeProgress: 100, length: 1234.6 });
  const done = await (await call(`/api/courses/videos/bunny/${id}`)).json();
  assert.strictEqual(done.status, 'completed');
  assert.strictEqual(done.duration_seconds, 1235);
  assert.strictEqual(done.video_url, `https://cdn.example.net/${id}/playlist.m3u8`);
  assert.strictEqual(done.thumbnail_url, `https://cdn.example.net/${id}/thumbnail.jpg`);
  assert.deepStrictEqual(done.available_resolutions, ['v240p', 'v720p']);
  videos.set(id, { status: 6, encodeProgress: 0, length: 0 });
  assert.strictEqual((await (await call(`/api/courses/videos/bunny/${id}`)).json()).status, 'failed');
  assert.strictEqual((await call('/api/courses/videos/bunny/not-an-id')).status, 400);
  videos.delete(id);
});

test('saving a course keeps the uploaded video, and nothing is deleted on Bunny', async () => {
  const title = 'TMP BUNNY UPLOAD TEST';
  let courseId;
  const a = crypto.randomUUID(); const b = crypto.randomUUID(); const orphan = crypto.randomUUID();
  [a, b, orphan].forEach((g) => videos.set(g, { status: 4, encodeProgress: 100, length: 60 }));
  try {
    courseId = (await (await call('/api/courses', 'POST', { title, instructor_name: 'T', price: 10 })).json()).id;
    const url = (g) => `https://cdn.example.net/${g}/playlist.m3u8`;
    const bad = await call(`/api/courses/${courseId}`, 'PUT', { ...base_, sections: [{ title: 'S', videos: [{ title: 'V', bunny_video_id: 'nope', video_url: url(a) }] }] });
    assert.strictEqual(bad.status, 400);
    const noLink = await call(`/api/courses/${courseId}`, 'PUT', { ...base_, sections: [{ title: 'S', videos: [{ title: 'V', bunny_video_id: a }] }] });
    assert.strictEqual(noLink.status, 400);
    const twice = await call(`/api/courses/${courseId}`, 'PUT', { ...base_, sections: [{ title: 'S', videos: [{ title: 'V1', bunny_video_id: a, video_url: url(a) }, { title: 'V2', bunny_video_id: a, video_url: url(a) }] }] });
    assert.strictEqual(twice.status, 400);

    const ok = await call(`/api/courses/${courseId}`, 'PUT', { ...base_, sections: [{ title: 'S', videos: [{ title: 'Lesson', bunny_video_id: a, video_url: url(a), thumbnail_url: `https://cdn.example.net/${a}/thumbnail.jpg`, duration_seconds: 60, available_resolutions: ['v240p', 'v720p'] }] }] });
    assert.strictEqual(ok.status, 200, await ok.clone().text());
    let row = (await pool.query(`SELECT v.* FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = $1`, [courseId])).rows[0];
    assert.deepStrictEqual([row.bunny_video_id, row.video_url, row.duration_seconds, row.encoding_status, row.upload_status, row.available_resolutions], [a, url(a), 60, 'completed', 'completed', ['v240p', 'v720p']]);
    assert.strictEqual(row.thumbnail_url, `https://cdn.example.net/${a}/thumbnail.jpg`);

    // replacing the file with a newly uploaded one changes the video's Bunny id and link
    const secId = (await pool.query('SELECT id FROM course_sections WHERE course_id = $1', [courseId])).rows[0].id;
    const rep = await call(`/api/courses/${courseId}`, 'PUT', { ...base_, sections: [{ id: secId, title: 'S', videos: [{ id: row.id, title: 'Lesson', bunny_video_id: b, video_url: url(b), duration_seconds: 90 }] }] });
    assert.strictEqual(rep.status, 200, await rep.clone().text());
    row = (await pool.query('SELECT * FROM course_videos WHERE id = $1', [row.id])).rows[0];
    assert.deepStrictEqual([row.bunny_video_id, row.video_url, row.duration_seconds], [b, url(b), 90]);

    // nothing on Bunny is ever deleted or changed by the server: there is no delete route, and it never sends one
    assert.strictEqual((await call(`/api/courses/videos/bunny/${orphan}`, 'DELETE')).status, 404);
    assert.ok(videos.has(orphan) && videos.has(a) && videos.has(b));
    assert.ok(!calls.some((c) => c.method === 'DELETE' || c.method === 'PUT' || c.method === 'PATCH'), 'only creates and reads');
  } finally {
    if (courseId) await pool.query('DELETE FROM courses WHERE id = $1', [courseId]);
    await pool.query("DELETE FROM courses WHERE title = $1", [title]);
  }
});

test('without Bunny settings the endpoints say so (503) and nothing is called', async () => {
  const saved = process.env.BUNNY_STREAM_API_KEY;
  delete process.env.BUNNY_STREAM_API_KEY;
  calls.length = 0;
  const r = await call('/api/courses/videos/upload', 'POST', { title: 'x' });
  assert.strictEqual(r.status, 503);
  assert.match((await r.json()).error, /not set up/);
  assert.strictEqual((await call(`/api/courses/videos/bunny/${crypto.randomUUID()}`)).status, 503);
  assert.strictEqual(calls.length, 0);
  process.env.BUNNY_STREAM_API_KEY = saved;
});
