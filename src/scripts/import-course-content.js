/**
 * One-off import of the course content from Supabase into the local database:
 *   course_sections, section_videos, course_resources, course_software_links,
 *   course_learning_points, course_reviews, course_promotions
 * ->  course_sections, course_videos, course_resources, course_software_links,
 *     course_learning_points, course_reviews, course_promotions
 *
 * Supabase is READ-ONLY here: only GET requests are made. Run import-courses.js first (it brings in the courses).
 * Safe to re-run: rows whose id already exists are skipped.
 *
 *   node src/scripts/import-course-content.js            # dry run (nothing written)
 *   node src/scripts/import-course-content.js --commit   # write to the local DB
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim());

async function fetchAll(table, select = '*') {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/${table}?select=${select}`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(`${table}: ${JSON.stringify(body)}`);
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

function build(src, { courseIds, accounts }) {
  const rejected = [];
  const stats = { resourcesWithoutVideo: 0, reviewsWithoutAccount: 0 };
  const reject = (table, id, reason) => rejected.push({ table, id, reason });

  const sections = [];
  for (const s of src.sections) {
    if (!courseIds.has(String(s.course_id))) { reject('section', s.section_id, `course ${s.course_id} not imported`); continue; }
    sections.push({ id: s.section_id, course_id: s.course_id, title: s.title, description: text(s.description), position: s.section_order, is_published: s.is_published === true, created_at: s.created_at, updated_at: s.updated_at || s.created_at });
  }
  const sectionIds = new Set(sections.map((s) => String(s.id)));

  const videos = [];
  for (const v of src.videos) {
    if (!sectionIds.has(String(v.section_id))) { reject('video', v.video_id, `section ${v.section_id} missing`); continue; }
    videos.push({
      id: v.video_id, section_id: v.section_id, title: v.title, description: text(v.description), video_url: text(v.video_url), bunny_video_id: text(v.bunny_video_id),
      thumbnail_url: text(v.thumbnail_url), duration_seconds: v.duration ?? null, position: v.video_order, is_free_preview: v.is_free_preview === true, is_published: v.is_published === true,
      encoding_status: text(v.encoding_status), upload_status: text(v.upload_status), needs_client_upload: v.needs_client_upload === true,
      available_resolutions: v.available_resolutions || [], created_at: v.created_at, updated_at: v.updated_at || v.created_at,
    });
  }
  const videoIds = new Set(videos.map((v) => String(v.id)));

  const resources = [];
  for (const r of src.resources) {
    if (!courseIds.has(String(r.course_id))) { reject('resource', r.resource_id, `course ${r.course_id} not imported`); continue; }
    const hasVideo = r.video_id != null && videoIds.has(String(r.video_id));
    if (r.video_id != null && !hasVideo) stats.resourcesWithoutVideo++;
    resources.push({
      id: r.resource_id, course_id: r.course_id, video_id: hasVideo ? r.video_id : null, title: r.title, description: text(r.description), resource_type: text(r.resource_type) || 'practice_file',
      file_url: text(r.file_url), file_name: text(r.file_name), file_size: r.file_size ?? null, mime_type: text(r.mime_type), thumbnail_url: text(r.thumbnail_url),
      position: r.resource_order ?? 1, is_published: r.is_published === true, created_at: r.created_at, updated_at: r.updated_at || r.created_at,
    });
  }

  const software = src.software.filter((s) => {
    if (courseIds.has(String(s.course_id))) return true;
    reject('software', s.software_id, `course ${s.course_id} not imported`);
    return false;
  }).map((s) => ({
    id: s.software_id, course_id: s.course_id, name: s.name, description: text(s.description), download_url: s.download_url, version: text(s.version), file_size: text(s.file_size),
    platform: text(s.platform), installation_instructions: text(s.installation_instructions), is_required: s.is_required === true, position: s.software_order ?? 1,
    created_at: s.created_at, updated_at: s.updated_at || s.created_at,
  }));

  const points = src.points.filter((p) => {
    if (courseIds.has(String(p.course_id))) return true;
    reject('learning point', p.point_id, `course ${p.course_id} not imported`);
    return false;
  }).map((p) => ({ id: p.point_id, course_id: p.course_id, text: p.point_text, position: p.point_order, created_at: p.created_at }));

  const studentById = new Map(src.students.map((u) => [u.user_id, u]));
  const reviews = [];
  for (const r of src.reviews) {
    if (!courseIds.has(String(r.course_id))) { reject('review', r.review_id, `course ${r.course_id} not imported`); continue; }
    if (!(r.rating >= 1 && r.rating <= 5)) { reject('review', r.review_id, `rating ${r.rating} out of range`); continue; }
    const student = studentById.get(r.student_id);
    const customerId = student ? accounts.get(String(student.email || '').trim().toLowerCase()) : null;
    if (!customerId) stats.reviewsWithoutAccount++;
    reviews.push({
      id: r.review_id, course_id: r.course_id, customer_id: customerId ?? null, reviewer_name: student ? text(student.full_name) : null,
      rating: r.rating, review_text: text(r.review_text), is_published: r.is_published === true, created_at: r.created_at, updated_at: r.updated_at || r.created_at,
    });
  }

  const promotions = src.promotions.map((p) => ({
    id: p.promotion_id, course_id: courseIds.has(String(p.course_id)) ? p.course_id : null, title: p.title, message: text(p.message), sub_text: text(p.sub_text),
    button_text: text(p.button_text), image_url: text(p.image_url), is_active: p.is_active !== false, target_users: text(p.target_users) || 'all',
    created_at: p.created_at, updated_at: p.updated_at || p.created_at,
  }));

  return { sections, videos, resources, software, points, reviews, promotions, rejected, stats };
}

async function insert(client, table, row) {
  const cols = Object.keys(row);
  const r = await client.query(
    `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT DO NOTHING`,
    cols.map((c) => row[c])
  );
  return r.rowCount;
}

(async () => {
  const [sections, videos, resources, software, points, reviews, promotions, students] = await Promise.all([
    fetchAll('course_sections'), fetchAll('section_videos'), fetchAll('course_resources'), fetchAll('course_software_links'),
    fetchAll('course_learning_points'), fetchAll('course_reviews'), fetchAll('course_promotions'),
    fetchAll('course_users', 'user_id,full_name,email'),
  ]);
  const courseIds = new Set((await pool.query('SELECT id FROM courses')).rows.map((r) => String(r.id)));
  const accounts = new Map((await pool.query('SELECT customer_id, LOWER(email) AS email FROM users')).rows.map((u) => [u.email, u.customer_id]));
  const built = build({ sections, videos, resources, software, points, reviews, promotions, students }, { courseIds, accounts });

  const plan = {
    sections: built.sections.length, videos: built.videos.length, resources: built.resources.length, software: built.software.length,
    learningPoints: built.points.length, reviews: built.reviews.length, promotions: built.promotions.length,
  };
  console.log({
    source: { sections: sections.length, videos: videos.length, resources: resources.length, software: software.length, learningPoints: points.length, reviews: reviews.length, promotions: promotions.length },
    toImport: plan, ...built.stats, rejected: built.rejected.length, mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (built.rejected.length) console.log('rejected:', built.rejected);
  if (!COMMIT) return;

  const client = await pool.connect();
  const done = {};
  const run = async (name, table, rows) => { done[name] = 0; for (const r of rows) done[name] += await insert(client, table, r); };
  try {
    await client.query('BEGIN');
    await run('sections', 'course_sections', built.sections);
    await run('videos', 'course_videos', built.videos);
    await run('resources', 'course_resources', built.resources);
    await run('software', 'course_software_links', built.software);
    await run('learningPoints', 'course_learning_points', built.points);
    await run('reviews', 'course_reviews', built.reviews);
    await run('promotions', 'course_promotions', built.promotions);
    for (const t of ['course_sections', 'course_videos', 'course_resources', 'course_software_links', 'course_learning_points', 'course_reviews', 'course_promotions']) {
      await client.query(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${t}), 1))`);
    }
    // the videos are in now, so every recorded watch can be checked against a real video
    await client.query('ALTER TABLE enrollment_video_progress VALIDATE CONSTRAINT enrollment_video_progress_video_fk');
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log({ inserted: done, progressLinkedToVideos: true });
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
