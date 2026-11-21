const { Router } = require('express');
const multer = require('multer');
const pool = require('../db');
const s3 = require('../s3');

const router = Router();
const bunny = require('../bunny');
const BUNNY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// the columns shown for a course, in the list and at the top of its detail page
const COURSE_SELECT = `SELECT c.id, c.title, c.description, c.instructor_name, c.language, c.status, c.is_published, c.thumbnail_url,
              c.price::float, c.certificate_with_price::float, c.certificate_without_price::float,
              c.duration, c.duration_months, c.category_id, cat.name AS category, c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM course_sections s WHERE s.course_id = c.id)::int AS sections,
              (SELECT COUNT(*) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id)::int AS videos,
              COALESCE((SELECT SUM(v.duration_seconds) FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = c.id), 0)::int AS duration_seconds,
              (SELECT COUNT(*) FROM course_resources r WHERE r.course_id = c.id)::int AS resources,
              (SELECT COUNT(DISTINCT e.customer_id) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed')::int AS students,
              COALESCE((SELECT SUM(e.amount_paid) FROM enrollments e WHERE e.course_id = c.id AND e.payment_status = 'completed'), 0)::float AS revenue,
              (SELECT COUNT(*) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::int AS review_count,
              (SELECT ROUND(AVG(rv.rating), 1) FROM course_reviews rv WHERE rv.course_id = c.id AND rv.is_published)::float AS avg_rating
         FROM courses c
         LEFT JOIN course_categories cat ON cat.id = c.category_id`;

/**
 * @openapi
 * /api/courses/summary:
 *   get:
 *     tags: [Courses]
 *     summary: Headline numbers for the Courses page
 *     responses:
 *       200: { description: "{ courses, published, sections, videos, durationSeconds, students, revenue, reviews, avgRating }" }
 */
router.get('/api/courses/summary', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT (SELECT COUNT(*) FROM courses)::int AS courses,
              (SELECT COUNT(*) FROM courses WHERE is_published)::int AS published,
              (SELECT COUNT(*) FROM course_sections)::int AS sections,
              (SELECT COUNT(*) FROM course_videos)::int AS videos,
              COALESCE((SELECT SUM(duration_seconds) FROM course_videos), 0)::int AS "durationSeconds",
              (SELECT COUNT(DISTINCT customer_id) FROM enrollments WHERE payment_status = 'completed' AND customer_id IS NOT NULL)::int AS students,
              COALESCE((SELECT SUM(amount_paid) FROM enrollments WHERE payment_status = 'completed'), 0)::float AS revenue,
              (SELECT COUNT(*) FROM course_reviews WHERE is_published)::int AS reviews,
              COALESCE((SELECT ROUND(AVG(rating), 1) FROM course_reviews WHERE is_published), 0)::float AS "avgRating"`
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('GET /api/courses/summary failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the course summary' });
  }
});

/**
 * @openapi
 * /api/courses:
 *   get:
 *     tags: [Courses]
 *     summary: List courses with their content, students, revenue and rating
 *     responses:
 *       200: { description: All courses (there are only a few), newest first }
 */
router.get('/api/courses', async (req, res) => {
  try {
    const { rows } = await pool.query(`${COURSE_SELECT}
        ORDER BY c.is_published DESC, c.created_at DESC, c.id DESC`);
    res.json({ data: rows, total: rows.length });
  } catch (err) {
    console.error('GET /api/courses failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch courses' });
  }
});

/**
 * @openapi
 * /api/courses/{id}:
 *   get:
 *     tags: [Courses]
 *     summary: One course's curriculum, learning points, practice files, software, reviews and promotions
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ course, sections (each with its videos), learningPoints, resources, software, reviews, promotions }" }
 *       404: { description: Course not found }
 */
router.get('/api/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid course id' });
  try {
    const header = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    if (!header.rowCount) return res.status(404).json({ error: 'Course not found' });

    const [sections, videos, learningPoints, resources, software, reviews, promotions] = await Promise.all([
      pool.query('SELECT id, title, description, position, is_published FROM course_sections WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT v.id, v.section_id, v.title, v.duration_seconds, v.position, v.is_free_preview, v.is_published, v.encoding_status,
                v.available_resolutions, v.thumbnail_url,
                (SELECT COUNT(*) FROM course_resources r WHERE r.video_id = v.id)::int AS resource_count
           FROM course_videos v JOIN course_sections s ON s.id = v.section_id
          WHERE s.course_id = $1 ORDER BY v.position, v.id`, [id]),
      pool.query('SELECT id, text, position FROM course_learning_points WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT r.id, r.title, r.description, r.resource_type, r.file_name, r.file_url, r.file_size::float AS file_size, r.mime_type, r.is_published,
                v.title AS video_title, s.title AS section_title, s.position AS section_position
           FROM course_resources r
           LEFT JOIN course_videos v ON v.id = r.video_id
           LEFT JOIN course_sections s ON s.id = v.section_id
          WHERE r.course_id = $1 ORDER BY s.position NULLS LAST, v.position NULLS LAST, r.position, r.id`, [id]),
      pool.query('SELECT id, name, description, platform, is_required, download_url, version, installation_instructions FROM course_software_links WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT rv.id, COALESCE(u.full_name, rv.reviewer_name) AS reviewer, rv.rating, rv.review_text, rv.is_published, rv.created_at
           FROM course_reviews rv LEFT JOIN users u ON u.customer_id = rv.customer_id
          WHERE rv.course_id = $1 ORDER BY rv.created_at DESC`, [id]),
      pool.query('SELECT id, title, sub_text, button_text, is_active, target_users FROM course_promotions WHERE course_id = $1 ORDER BY id', [id]),
    ]);

    const byId = new Map(sections.rows.map((s) => [String(s.id), { ...s, videos: [] }]));
    for (const v of videos.rows) byId.get(String(v.section_id))?.videos.push(v);
    res.json({
      course: header.rows[0],
      sections: [...byId.values()].map((s) => ({ ...s, duration_seconds: s.videos.reduce((n, v) => n + (v.duration_seconds || 0), 0) })),
      learningPoints: learningPoints.rows,
      resources: resources.rows,
      software: software.rows,
      reviews: reviews.rows,
      promotions: promotions.rows,
    });
  } catch (err) {
    console.error('GET /api/courses/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the course' });
  }
});

/**
 * @openapi
 * /api/courses/{id}/curriculum:
 *   get:
 *     tags: [Courses]
 *     summary: A course's sections with their videos, for the edit form
 *     description: >
 *       Each video says whether it has a playback link (has_video_link) but the link itself is never returned.
 *       watchers = students who have started the video, files = practice files attached to it.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ sections: [ { ..., videos: [...] } ] }" }
 *       404: { description: Course not found }
 */
router.get('/api/courses/:id/curriculum', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid course id' });
  try {
    const exists = await pool.query('SELECT 1 FROM courses WHERE id = $1', [id]);
    if (!exists.rowCount) return res.status(404).json({ error: 'Course not found' });
    const [sections, videos] = await Promise.all([
      pool.query('SELECT id, title, description, position, is_published FROM course_sections WHERE course_id = $1 ORDER BY position, id', [id]),
      pool.query(
        `SELECT v.id, v.section_id, v.title, v.description, v.duration_seconds, v.position, v.is_free_preview, v.is_published,
                v.thumbnail_url,
                (v.video_url IS NOT NULL AND v.video_url <> '') AS has_video_link,
                (SELECT COUNT(*) FROM enrollment_video_progress p WHERE p.video_id = v.id)::int AS watchers,
                (SELECT COUNT(*) FROM course_resources r WHERE r.video_id = v.id)::int AS files
           FROM course_videos v JOIN course_sections s ON s.id = v.section_id
          WHERE s.course_id = $1 ORDER BY v.position, v.id`, [id]),
    ]);
    const bySection = new Map(sections.rows.map((s) => [String(s.id), { ...s, videos: [] }]));
    for (const v of videos.rows) bySection.get(String(v.section_id))?.videos.push(v);
    res.json({ sections: [...bySection.values()] });
  } catch (err) {
    console.error('GET /api/courses/:id/curriculum failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch the curriculum' });
  }
});

// ---------- creating and editing a course ----------
const text = (v) => (v == null ? '' : String(v).trim());
const ALLOWED = ['title', 'description', 'instructor_name', 'language', 'category_id', 'new_category', 'price', 'certificate_with_price',
  'access_months', 'status', 'thumbnail_url', 'learning_points', 'sections', 'software'];

/**
 * @openapi
 * /api/course-categories:
 *   get:
 *     tags: [Courses]
 *     summary: Course categories (for the category dropdown)
 *     responses:
 *       200: { description: Categories ordered by name }
 */
router.get('/api/course-categories', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT id, name FROM course_categories ORDER BY LOWER(name)');
    res.json({ data: rows });
  } catch (err) {
    console.error('GET /api/course-categories failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * Checks a course body, the same way for creating and for editing.
 * Returns { error } or { fields } when something is wrong, otherwise { v } with the cleaned values.
 * A list that is left out comes back as undefined (editing keeps it as it is; creating treats it as empty).
 */
function validateCourse(b) {
  const unknown = Object.keys(b).filter((k) => !ALLOWED.includes(k));
  if (unknown.length) return { error: `Unknown fields: ${unknown.join(', ')}` };
  const fields = {};

  const title = text(b.title);
  if (!title) fields.title = 'is required';
  else if (title.length > 200) fields.title = 'must be at most 200 characters';

  const description = text(b.description);
  if (description.length > 5000) fields.description = 'must be at most 5000 characters';

  const instructor = text(b.instructor_name);
  if (!instructor) fields.instructor_name = 'is required';
  else if (instructor.length > 100) fields.instructor_name = 'must be at most 100 characters';

  const language = text(b.language);
  if (language.length > 50) fields.language = 'must be at most 50 characters';

  const num = (v) => (v === '' || v == null ? null : Number(v));
  const price = num(b.price);
  if (price == null) fields.price = 'is required';
  else if (!Number.isFinite(price) || price < 0) fields.price = 'must be a number of 0 or more';

  const certPrice = num(b.certificate_with_price);
  if (certPrice != null) {
    if (!Number.isFinite(certPrice) || certPrice < 0) fields.certificate_with_price = 'must be a number of 0 or more';
    else if (fields.price === undefined && price != null && certPrice < price) fields.certificate_with_price = 'must be at least the course price';
  }

  const months = num(b.access_months);
  if (months != null && (!Number.isInteger(months) || months < 1 || months > 120)) fields.access_months = 'must be a whole number of months from 1 to 120';

  const status = b.status === undefined || b.status === '' ? 'draft' : b.status;
  if (!['draft', 'published'].includes(status)) fields.status = 'must be draft or published';

  const thumb = text(b.thumbnail_url);
  if (thumb && (thumb.length > 2000 || !/^https?:\/\//i.test(thumb))) fields.thumbnail_url = 'must be a link starting with http:// or https://';

  const idOf = (x) => (x && x.id != null && x.id !== '' ? Number(x.id) : null);
  const badId = (id) => id !== null && !(Number.isInteger(id) && id >= 1);

  let points;
  if (b.learning_points !== undefined) {
    if (!Array.isArray(b.learning_points)) fields.learning_points = 'must be a list';
    else {
      points = b.learning_points.map(text).filter(Boolean);
      if (points.length > 20) fields.learning_points = 'can have at most 20 points';
      else if (points.some((p) => p.length > 500)) fields.learning_points = 'each point must be at most 500 characters';
    }
  }

  // the videos listed under one section. A section that sends no "videos" keeps the ones it has.
  const validateVideos = (list, label) => {
    if (!Array.isArray(list)) return { error: `${label}: videos must be a list` };
    const rows = list
      .map((x) => ({
        id: idOf(x), title: text(x && x.title),
        // a field that is not sent stays undefined, so editing a video never resets what it did not mention
        description: x && x.description !== undefined ? text(x.description) : undefined,
        video_url: text(x && x.video_url),
        // set when the admin uploaded the file to Bunny from the page (see /api/courses/videos/upload)
        bunny_video_id: text(x && x.bunny_video_id) || undefined,
        thumbnail_url: text(x && x.thumbnail_url) || undefined,
        available_resolutions: Array.isArray(x && x.available_resolutions) ? x.available_resolutions.map((r) => String(r).trim()).filter(Boolean).slice(0, 12) : undefined,
        duration_seconds: !x || x.duration_seconds === undefined ? undefined : x.duration_seconds === null || x.duration_seconds === '' ? null : Number(x.duration_seconds),
        is_free_preview: x && x.is_free_preview !== undefined ? Boolean(x.is_free_preview) : undefined,
        is_published: x && x.is_published !== undefined ? Boolean(x.is_published) : undefined,
      }))
      .filter((x) => x.id !== null || x.title || x.description || x.video_url || (x.duration_seconds !== undefined && x.duration_seconds !== null));
    if (rows.length > 200) return { error: `${label} can have at most 200 videos` };
    for (const [i, x] of rows.entries()) {
      const n = `${label}, video ${i + 1}`;
      if (badId(x.id)) return { error: `${n}: invalid id` };
      if (!x.title || x.title.length > 200) return { error: `${n} needs a title of up to 200 characters` };
      if (x.description && x.description.length > 5000) return { error: `${n}: the description is too long (5000 characters at most)` };
      if (x.video_url && (x.video_url.length > 2000 || !/^https?:\/\//i.test(x.video_url))) return { error: `${n}: the video link must start with http:// or https://` };
      if (x.bunny_video_id && !BUNNY_ID.test(x.bunny_video_id)) return { error: `${n}: the uploaded video id is not valid` };
      if (x.bunny_video_id && !x.video_url) return { error: `${n}: an uploaded video needs its video link` };
      if (x.thumbnail_url && (x.thumbnail_url.length > 2000 || !/^https?:\/\//i.test(x.thumbnail_url))) return { error: `${n}: the picture link must start with http:// or https://` };
      if (x.duration_seconds !== undefined && x.duration_seconds !== null && !(Number.isInteger(x.duration_seconds) && x.duration_seconds >= 0 && x.duration_seconds <= 86400)) return { error: `${n}: the length must be between 0 and 24 hours` };
    }
    const ids = rows.map((x) => x.id).filter((x) => x !== null);
    if (new Set(ids).size !== ids.length) return { error: `${label} lists the same video twice` };
    const bunnyIds = rows.map((x) => x.bunny_video_id).filter(Boolean);
    if (new Set(bunnyIds).size !== bunnyIds.length) return { error: `${label} uses the same uploaded video twice` };
    return { rows };
  };

  // sections, and optionally the videos in each (a video file itself needs an upload, so only its details and link are handled here)
  let sections;
  if (b.sections !== undefined) {
    if (!Array.isArray(b.sections)) fields.sections = 'must be a list';
    else {
      const raw = b.sections
        .map((x) => ({ x, id: idOf(x), title: text(x && x.title), description: text(x && x.description) }))
        .filter((r) => r.id !== null || r.title || r.description);
      const rows = [];
      let problem = '';
      for (const [i, r] of raw.entries()) {
        if (badId(r.id) || !r.title || r.title.length > 200 || r.description.length > 2000) {
          problem = problem || `section ${i + 1} needs a title of up to 200 characters${r.description.length > 2000 ? ' and a description of up to 2000' : ''}`;
          continue;
        }
        const row = { id: r.id, title: r.title, description: r.description };
        if (r.x.videos !== undefined) {
          const checked = validateVideos(r.x.videos, `section ${i + 1}`);
          if (checked.error) { problem = problem || checked.error; continue; }
          row.videos = checked.rows;
        }
        rows.push(row);
      }
      const ids = rows.map((x) => x.id).filter((x) => x !== null);
      if (raw.length > 100) fields.sections = 'can have at most 100 sections';
      else if (problem) fields.sections = problem;
      else if (new Set(ids).size !== ids.length) fields.sections = 'lists the same section twice';
      else sections = rows;
    }
  }

  // software the course needs
  let software;
  if (b.software !== undefined) {
    if (!Array.isArray(b.software)) fields.software = 'must be a list';
    else {
      const rows = b.software
        .map((x) => ({
          id: idOf(x), name: text(x && x.name), download_url: text(x && x.download_url), platform: text(x && x.platform),
          is_required: Boolean(x && x.is_required), description: text(x && x.description),
        }))
        .filter((x) => x.id !== null || x.name || x.download_url || x.platform || x.description);
      const bad = rows.findIndex((x) => badId(x.id) || !x.name || x.name.length > 200 || !/^https?:\/\//i.test(x.download_url) || x.download_url.length > 2000 || x.platform.length > 50 || x.description.length > 5000);
      const ids = rows.map((x) => x.id).filter((x) => x !== null);
      if (rows.length > 20) fields.software = 'can have at most 20 items';
      else if (bad >= 0) fields.software = `item ${bad + 1} needs a name and a download link starting with http:// or https://`;
      else if (new Set(ids).size !== ids.length) fields.software = 'lists the same item twice';
      else software = rows;
    }
  }

  const newCategory = text(b.new_category);
  const hasId = b.category_id !== undefined && b.category_id !== null && b.category_id !== '';
  if (hasId && newCategory) fields.category_id = 'choose an existing category or a new one, not both';
  else if (newCategory.length > 100) fields.new_category = 'must be at most 100 characters';
  else if (hasId && !(Number.isInteger(Number(b.category_id)) && Number(b.category_id) >= 1)) fields.category_id = 'is not valid';

  if (Object.keys(fields).length) return { fields };
  return {
    v: { title, description, instructor, language, price, certPrice, months, status, thumb, points, sections, software, newCategory, categoryId: hasId ? Number(b.category_id) : null },
  };
}

const bad = (res, fields) => res.status(400).json({ error: 'Validation failed', fields });

/** The category the course ends up in: an existing one by id, a new one by name (reused if the name exists), or none. */
async function resolveCategory(client, v) {
  if (v.categoryId !== null) {
    const cat = await client.query('SELECT id FROM course_categories WHERE id = $1', [v.categoryId]);
    return cat.rowCount ? { id: cat.rows[0].id } : { error: { category_id: 'does not exist' } };
  }
  if (v.newCategory) {
    const found = await client.query('SELECT id FROM course_categories WHERE LOWER(name) = LOWER($1)', [v.newCategory]);
    if (found.rowCount) return { id: found.rows[0].id };
    return { id: (await client.query('INSERT INTO course_categories (name) VALUES ($1) RETURNING id', [v.newCategory])).rows[0].id };
  }
  return { id: null };
}

const insertPoints = async (client, courseId, points) => {
  for (let i = 0; i < points.length; i++) {
    await client.query('INSERT INTO course_learning_points (course_id, text, position) VALUES ($1, $2, $3)', [courseId, points[i], i + 1]);
  }
};
const insertSection = (client, courseId, s, position) =>
  client.query('INSERT INTO course_sections (course_id, title, description, position) VALUES ($1, $2, $3, $4) RETURNING id', [courseId, s.title, s.description || null, position]);

/** Thrown inside a transaction when the request is fine in shape but not allowed (the handler turns it into a 400). */
class InvalidCourse extends Error {
  constructor(fields) { super('Validation failed'); this.fields = fields; }
}

/**
 * Makes the videos of one section match the list sent: a video with an id is updated and given its new place,
 * one without an id is added, and a video that is not sent is removed. A video that students have started, or that has
 * practice files, cannot be removed. A video link is only changed when a new one is sent (the old link is never shown).
 */
async function applyVideos(client, sectionId, videos) {
  const existing = (await client.query(
    `SELECT v.id, v.title,
            (SELECT COUNT(*) FROM enrollment_video_progress p WHERE p.video_id = v.id)::int AS watchers,
            (SELECT COUNT(*) FROM course_resources r WHERE r.video_id = v.id)::int AS files
       FROM course_videos v WHERE v.section_id = $1`, [sectionId]
  )).rows;
  const known = new Set(existing.map((e) => Number(e.id)));
  const foreign = videos.find((v) => v.id !== null && !known.has(v.id));
  if (foreign) throw new InvalidCourse({ sections: `video ${foreign.id} does not belong to that section` });
  const keep = new Set(videos.filter((v) => v.id !== null).map((v) => v.id));
  const removing = existing.filter((e) => !keep.has(Number(e.id)));
  const stuck = removing.find((e) => e.watchers > 0 || e.files > 0);
  if (stuck) {
    const why = stuck.watchers > 0
      ? `${stuck.watchers} ${stuck.watchers === 1 ? 'student has' : 'students have'} watched it`
      : `it has ${stuck.files} practice ${stuck.files === 1 ? 'file' : 'files'}`;
    throw new InvalidCourse({ sections: `"${stuck.title}" cannot be removed: ${why}` });
  }
  if (removing.length) await client.query('DELETE FROM course_videos WHERE id = ANY($1)', [removing.map((e) => e.id)]);
  await client.query('UPDATE course_videos SET position = position + 1000000 WHERE section_id = $1', [sectionId]); // frees the unique positions while they are renumbered
  for (const [i, v] of videos.entries()) {
    if (v.id !== null) {
      const sets = ['title = $1', 'position = $2', 'updated_at = NOW()'];
      const args = [v.title, i + 1];
      const add = (column, value) => { args.push(value); sets.push(`${column} = $${args.length}`); };
      if (v.description !== undefined) add('description', v.description || null);
      if (v.video_url) add('video_url', v.video_url); // the old link is only replaced by a new one
      if (v.bunny_video_id) { // a freshly uploaded video replaces the old one: its Bunny id, picture and encoding state go with the link
        add('bunny_video_id', v.bunny_video_id);
        if (v.thumbnail_url) add('thumbnail_url', v.thumbnail_url);
        add('encoding_status', 'completed');
        add('upload_status', 'completed');
        add('needs_client_upload', false);
        add('available_resolutions', v.available_resolutions || []);
      }
      if (v.duration_seconds !== undefined) add('duration_seconds', v.duration_seconds);
      if (v.is_free_preview !== undefined) add('is_free_preview', v.is_free_preview);
      if (v.is_published !== undefined) add('is_published', v.is_published);
      args.push(v.id, sectionId);
      await client.query(`UPDATE course_videos SET ${sets.join(', ')} WHERE id = $${args.length - 1} AND section_id = $${args.length}`, args);
    } else {
      await client.query(
        `INSERT INTO course_videos (section_id, title, description, video_url, duration_seconds, position, is_free_preview, is_published,
                                   bunny_video_id, thumbnail_url, encoding_status, upload_status, available_resolutions)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11, $12)`,
        [sectionId, v.title, v.description || null, v.video_url || null, v.duration_seconds ?? null, i + 1, v.is_free_preview ?? false, v.is_published ?? false,
         v.bunny_video_id || null, v.bunny_video_id ? v.thumbnail_url || null : null, v.bunny_video_id ? 'completed' : null, v.available_resolutions || []]
      );
    }
  }
}

/** Keeps the course's "17h 47m" label in step with its videos. */
async function refreshDurationLabel(client, courseId) {
  const total = (await client.query(
    `SELECT COALESCE(SUM(v.duration_seconds), 0)::int AS s FROM course_videos v JOIN course_sections x ON x.id = v.section_id WHERE x.course_id = $1`, [courseId]
  )).rows[0].s;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  await client.query('UPDATE courses SET duration = $1 WHERE id = $2', [total ? (h ? `${h}h ${m}m` : `${m}m`) : null, courseId]);
}
const insertSoftware = (client, courseId, x, position) =>
  client.query(
    `INSERT INTO course_software_links (course_id, name, description, download_url, platform, is_required, position) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [courseId, x.name, x.description || null, x.download_url, x.platform || null, x.is_required, position]
  );

/**
 * @openapi
 * /api/courses:
 *   post:
 *     tags: [Courses]
 *     summary: Create a course (a draft unless status is "published")
 *     description: >
 *       Creates the course and its "what students will learn" list, sections and software. Videos are added separately.
 *       Pick a category with category_id, or give new_category to create one. The price without certificate is the course price.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [title, instructor_name, price]
 *             properties:
 *               title: { type: string }
 *               description: { type: string }
 *               instructor_name: { type: string }
 *               language: { type: string }
 *               category_id: { type: integer }
 *               new_category: { type: string }
 *               price: { type: number }
 *               certificate_with_price: { type: number, description: Must be at least the course price }
 *               access_months: { type: integer }
 *               status: { type: string, enum: [draft, published], default: draft }
 *               thumbnail_url: { type: string }
 *               learning_points: { type: array, items: { type: string }, description: Up to 20 points of up to 500 characters }
 *               sections: { type: array, items: { type: object, properties: { title: { type: string }, description: { type: string } } }, description: Up to 100 sections, created unpublished and in order }
 *               software: { type: array, items: { type: object, properties: { name: { type: string }, download_url: { type: string }, platform: { type: string }, is_required: { type: boolean }, description: { type: string } } } }
 *     responses:
 *       201: { description: The new course }
 *       400: { description: Validation failed }
 */
router.post('/api/courses', async (req, res) => {
  const checked = validateCourse(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (checked.fields) return bad(res, checked.fields);
  const { v } = checked;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const dup = await client.query('SELECT 1 FROM courses WHERE LOWER(title) = LOWER($1)', [v.title]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return bad(res, { title: 'is already used by another course' }); }
    const cat = await resolveCategory(client, v);
    if (cat.error) { await client.query('ROLLBACK'); return bad(res, cat.error); }

    const inserted = await client.query(
      `INSERT INTO courses (title, description, instructor_name, price, certificate_with_price, certificate_without_price,
                            is_published, status, category_id, thumbnail_url, language, duration_months)
       VALUES ($1, $2, $3, $4, $5, $4, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [v.title, v.description || null, v.instructor, v.price, v.certPrice, v.status === 'published', v.status, cat.id, v.thumb || null, v.language || null, v.months]
    );
    const id = inserted.rows[0].id;
    await insertPoints(client, id, v.points || []);
    let withVideos = false;
    for (const [i, s] of (v.sections || []).entries()) {
      const made = await insertSection(client, id, s, i + 1);
      if (s.videos) { await applyVideos(client, made.rows[0].id, s.videos.map((x) => ({ ...x, id: null }))); withVideos = true; }
    }
    if (withVideos) await refreshDurationLabel(client, id);
    for (const [i, x] of (v.software || []).entries()) await insertSoftware(client, id, x, i + 1);
    await client.query('COMMIT');

    const { rows } = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    res.status(201).json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof InvalidCourse) return bad(res, err.fields);
    console.error('POST /api/courses failed:', err.message);
    res.status(500).json({ error: 'Failed to create the course' });
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/courses/{id}:
 *   put:
 *     tags: [Courses]
 *     summary: Edit a course
 *     description: >
 *       Same fields and checks as creating. title, instructor_name and price are always needed.
 *       learning_points, sections and software replace the existing list when they are sent, and leave it alone when they are left out.
 *       In sections and software, an item with an "id" is updated, an item without one is added, and an existing item that is not
 *       sent is removed. A section that has videos cannot be removed (it can be renamed and moved). A section may also send a
 *       "videos" list ({ id?, title, description, video_url, duration_seconds, is_free_preview, is_published }): same rules, and a video that
 *       students have watched, or that has practice files, cannot be removed. The course's duration label follows the videos.
 *       Changing the price does not change what students already paid.
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: The updated course }
 *       400: { description: Validation failed }
 *       404: { description: Course not found }
 */
router.put('/api/courses/:id', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid course id' });
  const checked = validateCourse(req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});
  if (checked.error) return res.status(400).json({ error: checked.error });
  if (checked.fields) return bad(res, checked.fields);
  const { v } = checked;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query('SELECT id FROM courses WHERE id = $1 FOR UPDATE', [id]);
    if (!current.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Course not found' }); }

    const dup = await client.query('SELECT 1 FROM courses WHERE LOWER(title) = LOWER($1) AND id <> $2', [v.title, id]);
    if (dup.rowCount) { await client.query('ROLLBACK'); return bad(res, { title: 'is already used by another course' }); }
    const cat = await resolveCategory(client, v);
    if (cat.error) { await client.query('ROLLBACK'); return bad(res, cat.error); }

    await client.query(
      `UPDATE courses SET title = $1, description = $2, instructor_name = $3, price = $4, certificate_with_price = $5, certificate_without_price = $4,
                          is_published = $6, status = $7, category_id = $8, thumbnail_url = $9, language = $10, duration_months = $11, updated_at = NOW()
        WHERE id = $12`,
      [v.title, v.description || null, v.instructor, v.price, v.certPrice, v.status === 'published', v.status, cat.id, v.thumb || null, v.language || null, v.months, id]
    );

    if (v.points) {
      await client.query('DELETE FROM course_learning_points WHERE course_id = $1', [id]);
      await insertPoints(client, id, v.points);
    }

    if (v.sections) {
      const existing = (await client.query(
        `SELECT s.id, s.title, (SELECT COUNT(*) FROM course_videos x WHERE x.section_id = s.id)::int AS videos FROM course_sections s WHERE s.course_id = $1`, [id]
      )).rows;
      const known = new Map(existing.map((e) => [Number(e.id), e]));
      const unknownId = v.sections.find((s) => s.id !== null && !known.has(s.id));
      if (unknownId) { await client.query('ROLLBACK'); return bad(res, { sections: `section ${unknownId.id} does not belong to this course` }); }
      const keep = new Set(v.sections.filter((s) => s.id !== null).map((s) => s.id));
      const removing = existing.filter((e) => !keep.has(Number(e.id)));
      const blocked = removing.find((e) => e.videos > 0);
      if (blocked) {
        await client.query('ROLLBACK');
        return bad(res, { sections: `"${blocked.title}" has ${blocked.videos} ${blocked.videos === 1 ? 'video' : 'videos'}, so it cannot be removed` });
      }
      if (removing.length) await client.query('DELETE FROM course_sections WHERE id = ANY($1)', [removing.map((e) => e.id)]);
      await client.query('UPDATE course_sections SET position = position + 1000000 WHERE course_id = $1', [id]); // frees the unique positions while they are renumbered
      let touchedVideos = false;
      for (const [i, s] of v.sections.entries()) {
        let sectionId = s.id;
        if (s.id !== null) {
          await client.query('UPDATE course_sections SET title = $1, description = $2, position = $3, updated_at = NOW() WHERE id = $4 AND course_id = $5', [s.title, s.description || null, i + 1, s.id, id]);
        } else {
          sectionId = (await insertSection(client, id, s, i + 1)).rows[0].id;
        }
        if (s.videos) { await applyVideos(client, sectionId, s.videos); touchedVideos = true; }
      }
      if (touchedVideos) await refreshDurationLabel(client, id);
    }

    if (v.software) {
      const existing = (await client.query('SELECT id FROM course_software_links WHERE course_id = $1', [id])).rows;
      const known = new Set(existing.map((e) => Number(e.id)));
      const unknownId = v.software.find((x) => x.id !== null && !known.has(x.id));
      if (unknownId) { await client.query('ROLLBACK'); return bad(res, { software: `item ${unknownId.id} does not belong to this course` }); }
      const keep = new Set(v.software.filter((x) => x.id !== null).map((x) => x.id));
      const removing = existing.filter((e) => !keep.has(Number(e.id))).map((e) => e.id);
      if (removing.length) await client.query('DELETE FROM course_software_links WHERE id = ANY($1)', [removing]);
      for (const [i, x] of v.software.entries()) {
        if (x.id !== null) {
          await client.query(
            `UPDATE course_software_links SET name = $1, description = $2, download_url = $3, platform = $4, is_required = $5, position = $6, updated_at = NOW() WHERE id = $7 AND course_id = $8`,
            [x.name, x.description || null, x.download_url, x.platform || null, x.is_required, i + 1, x.id, id]
          );
        } else {
          await insertSoftware(client, id, x, i + 1);
        }
      }
    }
    await client.query('COMMIT');

    const { rows } = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (err instanceof InvalidCourse) return bad(res, err.fields);
    console.error('PUT /api/courses/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to save the course' });
  } finally {
    client.release();
  }
});

/**
 * @openapi
 * /api/courses/{id}/status:
 *   patch:
 *     tags: [Courses]
 *     summary: Publish a course, or take it back to a draft
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [status]
 *             properties:
 *               status: { type: string, enum: [draft, published] }
 *     responses:
 *       200: { description: The updated course }
 *       400: { description: Invalid status }
 *       404: { description: Course not found }
 */
router.patch('/api/courses/:id/status', async (req, res) => {
  const id = Number(req.params.id);
  const status = req.body && req.body.status;
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid course id' });
  if (!['draft', 'published'].includes(status)) return res.status(400).json({ error: 'status must be draft or published' });
  try {
    const done = await pool.query(`UPDATE courses SET status = $1::varchar, is_published = ($1::text = 'published'), updated_at = NOW() WHERE id = $2`, [status, id]);
    if (!done.rowCount) return res.status(404).json({ error: 'Course not found' });
    const { rows } = await pool.query(`${COURSE_SELECT} WHERE c.id = $1`, [id]);
    res.json(rows[0]);
  } catch (err) {
    console.error('PATCH /api/courses/:id/status failed:', err.message);
    res.status(500).json({ error: 'Failed to change the status' });
  }
});

/**
 * @openapi
 * /api/courses/videos/upload:
 *   post:
 *     tags: [Courses]
 *     summary: Start a course video upload. Creates the video on Bunny and returns what the browser needs to upload the file straight to Bunny (TUS)
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, required: [title], properties: { title: { type: string } } }
 *     responses:
 *       201: { description: "{ bunny_video_id, tus: { endpoint, signature, expires, libraryId, videoId } }" }
 *       400: { description: No title }
 *       503: { description: Bunny is not set up on the server }
 */
router.post('/api/courses/videos/upload', async (req, res) => {
  const title = String((req.body && req.body.title) || '').trim();
  if (!title) return res.status(400).json({ error: 'Give the video a title first' });
  if (!bunny.isConfigured()) return res.status(503).json({ error: 'Video upload is not set up on the server yet (the Bunny settings are missing)' });
  try {
    const id = await bunny.createVideo(title);
    res.status(201).json({ bunny_video_id: id, tus: bunny.tusSignature(id) });
  } catch (err) {
    console.error('POST /api/courses/videos/upload failed:', err.message);
    res.status(502).json({ error: 'Could not start the upload. Please try again.' });
  }
});

/**
 * @openapi
 * /api/courses/videos/bunny/{id}:
 *   get:
 *     tags: [Courses]
 *     summary: Where Bunny is with an uploaded video (uploaded, processing with a percentage, completed or failed), and its links and length once ready
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: string } }
 *     responses:
 *       200: { description: "{ bunny_video_id, status, progress, duration_seconds, video_url, thumbnail_url, available_resolutions }" }
 *       400: { description: Not a video id }
 */
router.get('/api/courses/videos/bunny/:id', async (req, res) => {
  if (!BUNNY_ID.test(req.params.id)) return res.status(400).json({ error: 'Not a video id' });
  if (!bunny.isConfigured()) return res.status(503).json({ error: 'Video upload is not set up on the server yet' });
  try {
    res.json(await bunny.getStatus(req.params.id));
  } catch (err) {
    console.error('GET /api/courses/videos/bunny/:id failed:', err.message);
    res.status(502).json({ error: 'Could not check the video. Please try again.' });
  }
});

/**
 * @openapi
 * /api/courses/videos/{id}/source:
 *   get:
 *     tags: [Courses]
 *     summary: Where to play one course video (its stream link and picture), for the admin's preview
 *     parameters:
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: "{ id, title, video_url, thumbnail_url, duration_seconds }" }
 *       404: { description: No such video, or it has no video link }
 */
router.get('/api/courses/videos/:id/source', async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(404).json({ error: 'Video not found' });
  try {
    const v = (await pool.query('SELECT id, title, video_url, thumbnail_url, duration_seconds FROM course_videos WHERE id = $1', [id])).rows[0];
    if (!v || !v.video_url) return res.status(404).json({ error: 'This video has no link yet' });
    res.setHeader('Cache-Control', 'no-store');
    res.json(v);
  } catch (err) {
    console.error('GET /api/courses/videos/:id/source failed:', err.message);
    res.status(500).json({ error: 'Could not load the video' });
  }
});

/**
 * @openapi
 * /api/courses/thumbnail:
 *   post:
 *     tags: [Courses]
 *     summary: Upload a course thumbnail
 *     description: multipart/form-data, field "file" (jpg, png, gif or webp, up to 5 MB). Returns the public link to put in thumbnail_url.
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file: { type: string, format: binary }
 *     responses:
 *       201: { description: "{ url }" }
 *       400: { description: No file, wrong type, or too large }
 */
const THUMB_TYPES = ['jpg', 'jpeg', 'png', 'gif', 'webp'];
const THUMB_MAX_MB = 5;
const thumbUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: THUMB_MAX_MB * 1024 * 1024, files: 1 },
  fileFilter: (req, file, cb) =>
    THUMB_TYPES.includes((file.originalname.split('.').pop() || '').toLowerCase()) ? cb(null, true) : cb(new Error('Use a jpg, png, gif or webp image')),
});

router.post('/api/courses/thumbnail', (req, res) => {
  if (!s3.configured) return res.status(503).json({ error: 'Image storage is not configured' });
  thumbUpload.single('file')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? `The image is larger than ${THUMB_MAX_MB} MB` : err.message });
    if (!req.file) return res.status(400).json({ error: 'No file was sent' });
    try {
      const saved = await s3.uploadImage(req.file, s3.COURSE_THUMBNAIL_FOLDER);
      res.status(201).json({ url: saved.url });
    } catch (e) {
      console.error('POST /api/courses/thumbnail failed:', e.name, e.message);
      res.status(502).json({ error: 'Upload failed' });
    }
  });
});

module.exports = router;
