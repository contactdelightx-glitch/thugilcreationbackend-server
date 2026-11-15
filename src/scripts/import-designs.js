/**
 * One-off import: Supabase public.designs -> one local table per saree style.
 *
 * Supabase is READ-ONLY here: only GET requests are made.
 * Safe to re-run: rows whose product_id already exists are skipped.
 *
 *   node src/scripts/import-designs.js            # dry run (nothing written)
 *   node src/scripts/import-designs.js --commit   # write to the local DB
 */
require('dotenv').config({ quiet: true });
const pool = require('../db');

const { SUPABASE_URL: URL_, SUPABASE_SERVICE_KEY: KEY } = process.env;
const COMMIT = process.argv.includes('--commit');

const WEAVE = ['butta_designs', 'brocade_designs', 'border_designs', 'pallu_designs', 'pattern_designs'];
const TABLE_FOR = {
  Butta: 'butta_designs',
  Brocade: 'brocade_designs',
  Border: 'border_designs',
  Pallu: 'pallu_designs',
  Pattern: 'pattern_designs',
  'Full Set': 'full_set_designs',
  'Free Image': 'free_image_designs',
};

async function fetchAll() {
  const rows = [];
  for (let from = 0; ; from += 1000) {
    const res = await fetch(`${URL_}/rest/v1/designs?select=*&order=id.asc`, {
      method: 'GET',
      headers: { apikey: KEY, Authorization: `Bearer ${KEY}`, Range: `${from}-${from + 999}` },
    });
    const body = await res.json();
    if (!Array.isArray(body)) throw new Error(JSON.stringify(body));
    rows.push(...body);
    if (body.length < 1000) return rows;
  }
}

// ---------- cleaning helpers ----------
const text = (v) => (v == null || String(v).trim() === '' ? null : String(v).trim().replace(/\s+/g, ' '));

// '620(Turning)' -> { value: 620, note: '620(Turning)' }; '240' -> { value: 240, note: null }
function intWithNote(v) {
  const s = text(v);
  if (s == null) return { value: null, note: null };
  const m = s.match(/^(\d+)/);
  if (!m) return { value: null, note: s };
  return { value: Number(m[1]), note: /^\d+$/.test(s) ? null : s };
}

function harnessBuild(v) {
  let s = text(v);
  if (!s) return null;
  s = s.toUpperCase().replace('DOBULE', 'DOUBLE').replace(/\s*\(/g, '(');
  if (s === 'S') s = 'SINGLE';
  return s;
}

const imageType = (v) => (text(v) ? text(v).toUpperCase() : null);
const timestamp = (v) => (/(Z|[+-]\d\d:?\d\d)$/.test(v) ? v : `${v}Z`); // source has no tz -> treat as UTC

function common(r) {
  return {
    id: r.id,
    product_id: r.product_id,
    designer_email: text(r.email).toLowerCase(),
    image_url: r.image_url,
    original_image_url: r.original_image_url,
    label: text(r.label) ? text(r.label).toLowerCase() : 'new',
    listing_rate: r.listing_rate ?? 0,
    final_price: r.final_price ?? 0,
    created_at: timestamp(r.created_at),
  };
}

function toRow(r) {
  const table = TABLE_FOR[r.saree_style];
  if (!table) throw new Error(`unknown saree_style "${r.saree_style}"`);
  const base = common(r);

  if (table === 'free_image_designs') {
    if (!text(r.redirect_url)) throw new Error('missing redirect_url');
    return { table, row: { ...base, redirect_url: r.redirect_url } };
  }

  if (table === 'full_set_designs') {
    return {
      table,
      row: {
        ...base,
        name: text(r.name),
        jacquard_type: text(r.jacquard_type)?.toLowerCase(),
        ppi: r.ppi,
        body_epi: r.body_epi,
        border_epi: r.border_epi,
        br_hooks: text(r.br_hooks),
        by_hooks: text(r.by_hooks),
        image_type: imageType(r.image_type),
      },
    };
  }

  const cards = intWithNote(r.cards);
  const hooks = intWithNote(r.hooks);
  const notes = [cards.note && `cards: ${cards.note}`, hooks.note && `hooks: ${hooks.note}`].filter(Boolean).join('; ');
  return {
    table,
    row: {
      ...base,
      name: text(r.name),
      cards: cards.value,
      hooks: hooks.value,
      epi: r.epi,
      ppi: r.ppi,
      harness_build: harnessBuild(r.harnessbuild),
      image_type: imageType(r.image_type),
      notes: notes || null,
    },
  };
}

(async () => {
  const source = await fetchAll();
  const byTable = {};
  const rejected = [];
  let notesCount = 0;
  let harnessFixed = 0;

  for (const r of source) {
    try {
      const { table, row } = toRow(r);
      (byTable[table] ||= []).push(row);
      if (row.notes) notesCount++;
      if (WEAVE.includes(table) && text(r.harnessbuild) !== row.harness_build) harnessFixed++;
    } catch (e) {
      rejected.push({ id: r.id, reason: e.message });
    }
  }

  console.log({
    source: source.length,
    perTable: Object.fromEntries(Object.entries(byTable).map(([t, rows]) => [t, rows.length])),
    rowsWithNotes: notesCount,
    harnessBuildNormalized: harnessFixed,
    rejected: rejected.length,
    mode: COMMIT ? 'COMMIT' : 'DRY RUN (nothing written)',
  });
  if (rejected.length) console.log('rejected rows:', rejected.slice(0, 20));
  if (!COMMIT) return;

  const client = await pool.connect();
  const result = {};
  try {
    await client.query('BEGIN');
    for (const [table, rows] of Object.entries(byTable)) {
      let inserted = 0;
      for (const row of rows) {
        const cols = Object.keys(row);
        const r = await client.query(
          `INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(',')})
           ON CONFLICT DO NOTHING`,
          cols.map((c) => row[c])
        );
        inserted += r.rowCount;
      }
      // new rows created later must not collide with imported ids
      await client.query(
        `SELECT setval(pg_get_serial_sequence('${table}', 'id'),
                       GREATEST((SELECT COALESCE(MAX(id), 0) FROM ${table}), 1))`
      );
      result[table] = { inserted, skipped: rows.length - inserted };
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  console.log(result);
})()
  .catch((e) => { console.error('IMPORT FAILED:', e.message); process.exitCode = 1; })
  .finally(() => pool.end());
