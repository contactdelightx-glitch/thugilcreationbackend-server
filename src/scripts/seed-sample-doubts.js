/**
 * Adds (or removes) a handful of SAMPLE doubts so the admin Doubts screen can be seen with data.
 *
 *   node src/scripts/seed-sample-doubts.js              # show what would be added
 *   node src/scripts/seed-sample-doubts.js --commit     # add them
 *   node src/scripts/seed-sample-doubts.js --remove     # delete every sample doubt again
 *
 * The students are made up (customer_id is empty, e-mails end in @example.com) and the questions are invented.
 * Sample doubts all have ids from 900001 upwards, so they never clash with real ones and are easy to remove.
 * The id sequence is not touched.
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const FIRST_ID = 900001;
const LAST_ID = 900099;
const COMMIT = process.argv.includes('--commit');
const REMOVE = process.argv.includes('--remove');

const STUDENTS = {
  priya: ['Priya Raman (sample)', 'sample.priya@example.com'],
  arun: ['Arun Kumar (sample)', 'sample.arun@example.com'],
  meera: ['Meera Nair (sample)', 'sample.meera@example.com'],
  karthik: ['Karthik S (sample)', 'sample.karthik@example.com'],
  divya: ['Divya Lakshmi (sample)', 'sample.divya@example.com'],
};

// [student, course id, video title to look for (null = a general question), question, hours ago it was asked, answer, hours after asking it was answered]
const SAMPLES = [
  ['priya', 2, 'PAINT BRUSH', 'The paint brush keeps painting a thick line even after I reduce the size. Is there a setting I missed in the tool options?', 5, null, null],
  ['arun', 2, 'FLOOD FILL', 'When I use flood fill the colour leaks into the neighbouring area. How do I stop it from spilling over?', 30, null, null],
  ['meera', 2, null, 'The software download link on the course page is not opening for me. Can you share another link?', 54, null, null],
  ['karthik', 2, 'MAGIC WAND', 'In the magic wand video the selection looks perfect, but on my file it selects the whole background. What tolerance value do you use?', 96, null, null],
  ['divya', 3, null, 'Is the practice file for the editing course the same as the one in the start-up saree designing course?', 190, null, null],
  ['arun', 2, 'CROP TOOL', 'How do I crop a butta exactly to a multiple of the card count so the repeat lines up?', 140, 'Set the crop width to a multiple of your hook count before you crop (for example 240 or 480), then tick "Snap to grid". The repeat will then line up when you tile it.', 20],
  ['priya', 2, 'TEXT TOOL', 'Can I use my own font with the text tool, or only the fonts that come with the software?', 200, 'Yes, any font installed on your computer shows up in the text tool. Install the font first, then restart the software so it appears in the list.', 6],
  ['meera', 3, null, 'How long will I have access to the editing course after I buy it?', 260, 'You get 2 months of access from the day you enrol. You can see the exact date on the course page under "Access until".', 3],
];

(async () => {
  if (REMOVE) {
    const r = await pool.query('DELETE FROM course_doubts WHERE id BETWEEN $1 AND $2', [FIRST_ID, LAST_ID]);
    console.log({ removedSampleDoubts: r.rowCount, doubtsLeft: (await pool.query('SELECT COUNT(*)::int AS n FROM course_doubts')).rows[0].n });
    return;
  }

  const rows = [];
  for (const [i, [who, courseId, videoTitle, question, hoursAgo, answer, answeredAfter]] of SAMPLES.entries()) {
    const course = await pool.query('SELECT id FROM courses WHERE id = $1', [courseId]);
    if (!course.rowCount) { console.log(`skipping sample ${i + 1}: course ${courseId} is not in this database`); continue; }
    let videoId = null;
    if (videoTitle) {
      const v = await pool.query(
        `SELECT v.id FROM course_videos v JOIN course_sections s ON s.id = v.section_id WHERE s.course_id = $1 AND v.title ILIKE $2 ORDER BY v.id LIMIT 1`,
        [courseId, `%${videoTitle}%`]
      );
      videoId = v.rows[0]?.id ?? null;
    }
    rows.push({ id: FIRST_ID + i, who, courseId, videoId, videoTitle, question, hoursAgo, answer, answeredAfter });
  }

  console.log(`${COMMIT ? 'Adding' : 'Would add'} ${rows.length} sample doubts (${rows.filter((r) => !r.answer).length} waiting, ${rows.filter((r) => r.answer).length} answered):`);
  for (const r of rows) console.log(`  #${r.id} ${r.answer ? 'answered' : 'waiting '} · ${STUDENTS[r.who][0]} · course ${r.courseId} · ${r.videoId ? `video "${r.videoTitle}"` : 'general'} · ${r.hoursAgo}h ago`);
  if (!COMMIT) return console.log('\nNothing written. Add --commit to write them.');

  let added = 0;
  for (const r of rows) {
    const res = await pool.query(
      `INSERT INTO course_doubts (id, customer_id, student_name, student_email, course_id, video_id, question, answer, status, answered_at, created_at, updated_at)
       VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8,
               CASE WHEN $7::text IS NULL THEN NULL ELSE NOW() - ($9 || ' hours')::interval + ($10 || ' hours')::interval END,
               NOW() - ($9 || ' hours')::interval,
               CASE WHEN $7::text IS NULL THEN NOW() - ($9 || ' hours')::interval ELSE NOW() - ($9 || ' hours')::interval + ($10 || ' hours')::interval END)
       ON CONFLICT DO NOTHING`,
      [r.id, STUDENTS[r.who][0], STUDENTS[r.who][1], r.courseId, r.videoId, r.question, r.answer, r.answer ? 'answered' : 'pending', String(r.hoursAgo), String(r.answeredAfter ?? 0)]
    );
    added += res.rowCount;
  }
  console.log({ added, alreadyThere: rows.length - added, doubtsInTable: (await pool.query('SELECT COUNT(*)::int AS n FROM course_doubts')).rows[0].n });
})()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
