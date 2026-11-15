const { Router } = require('express');
const pool = require('../db');

const router = Router();

// category key -> table. Only these names are ever put into SQL.
const CATEGORIES = {
  butta: { table: 'butta_designs', label: 'Butta' },
  brocade: { table: 'brocade_designs', label: 'Brocade' },
  border: { table: 'border_designs', label: 'Border' },
  pallu: { table: 'pallu_designs', label: 'Pallu' },
  pattern: { table: 'pattern_designs', label: 'Pattern' },
  full_set: { table: 'full_set_designs', label: 'Full Set' },
  free_image: { table: 'free_image_designs', label: 'Free Image' },
};
const LABELS = ['new', 'sale', 'featured'];

// "All" view: only the columns every category shares.
// free_image_designs has no name column.
const commonSelect = (key) => {
  const { table } = CATEGORIES[key];
  const name = key === 'free_image' ? 'NULL::varchar' : 'name';
  return `SELECT id, product_id, ${name} AS name, designer_email, image_url, label,
                 listing_rate, final_price, created_at, '${key}' AS category
            FROM ${table}`;
};

// Single-category view: every column of that category's own table.
const fullSelect = (key) => {
  const { table } = CATEGORIES[key];
  const name = key === 'free_image' ? 'NULL::varchar AS name, ' : '';
  return `SELECT *, ${name}'${key}' AS category FROM ${table}`;
};

/**
 * @openapi
 * /api/designs/categories:
 *   get:
 *     tags: [Designs]
 *     summary: Saree styles with their design counts
 *     responses:
 *       200: { description: List of categories }
 */
router.get('/api/designs/categories', async (req, res) => {
  try {
    const keys = Object.keys(CATEGORIES);
    const counts = await Promise.all(
      keys.map((k) => pool.query(`SELECT COUNT(*)::int AS n FROM ${CATEGORIES[k].table}`))
    );
    res.json(keys.map((k, i) => ({ key: k, label: CATEGORIES[k].label, count: counts[i].rows[0].n })));
  } catch (err) {
    console.error('GET /api/designs/categories failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * @openapi
 * /api/designs:
 *   get:
 *     tags: [Designs]
 *     summary: List designs (paginated). One category returns all of its columns; all returns the shared columns
 *     parameters:
 *       - { in: query, name: category, schema: { type: string, enum: [all, butta, brocade, border, pallu, pattern, full_set, free_image], default: all } }
 *       - { in: query, name: label, schema: { type: string, enum: [all, new, sale, featured], default: all } }
 *       - { in: query, name: search, schema: { type: string }, description: Matches name, product id or designer email }
 *       - { in: query, name: page, schema: { type: integer, default: 1 } }
 *       - { in: query, name: offset, schema: { type: integer }, description: Start position; overrides page (used for infinite scroll) }
 *       - { in: query, name: limit, schema: { type: integer, default: 12, maximum: 60 } }
 *     responses:
 *       200: { description: A page of designs }
 *       400: { description: Unknown category }
 */
router.get('/api/designs', async (req, res) => {
  const category = req.query.category || 'all';
  if (category !== 'all' && !CATEGORIES[category]) return res.status(400).json({ error: 'Unknown category' });

  const page = Math.max(parseInt(req.query.page, 10) || 1, 1);
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 12, 1), 60);
  const search = String(req.query.search || '').trim();
  const offset = req.query.offset !== undefined ? Math.max(parseInt(req.query.offset, 10) || 0, 0) : (page - 1) * limit;

  const where = [];
  const params = [];
  if (search) {
    params.push(`%${search}%`);
    where.push(`(name ILIKE $${params.length} OR product_id ILIKE $${params.length} OR designer_email ILIKE $${params.length})`);
  }
  if (LABELS.includes(req.query.label)) {
    params.push(req.query.label);
    where.push(`label = $${params.length}`);
  }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const keys = category === 'all' ? Object.keys(CATEGORIES) : [category];
  const source =
    category === 'all'
      ? `(${keys.map(commonSelect).join(' UNION ALL ')}) d`
      : `(${fullSelect(category)}) d`;

  try {
    const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${source} ${clause}`, params)).rows[0].n;
    const { rows } = await pool.query(
      `SELECT * FROM ${source} ${clause}
        ORDER BY created_at DESC, id DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset]
    );
    res.json({ data: rows, page, limit, offset, total, hasMore: offset + rows.length < total, totalPages: Math.max(Math.ceil(total / limit), 1) });
  } catch (err) {
    console.error('GET /api/designs failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch designs' });
  }
});

/**
 * @openapi
 * /api/designs/{category}/{id}:
 *   get:
 *     tags: [Designs]
 *     summary: Full details of one design
 *     parameters:
 *       - { in: path, name: category, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       200: { description: The design with all of its fields }
 *       404: { description: Not found }
 */
router.get('/api/designs/:category/:id', async (req, res) => {
  const cat = CATEGORIES[req.params.category];
  const id = Number(req.params.id);
  if (!cat) return res.status(400).json({ error: 'Unknown category' });
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid design id' });
  try {
    const { rows } = await pool.query(`SELECT * FROM ${cat.table} WHERE id = $1`, [id]);
    if (!rows.length) return res.status(404).json({ error: 'Design not found' });
    res.json({ ...rows[0], category: req.params.category });
  } catch (err) {
    console.error('GET /api/designs/:category/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to fetch design' });
  }
});

/**
 * @openapi
 * /api/designs/{category}/{id}/label:
 *   patch:
 *     tags: [Designs]
 *     summary: Change a design's label (new, sale or featured)
 *     parameters:
 *       - { in: path, name: category, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [label]
 *             properties:
 *               label: { type: string, enum: [new, sale, featured] }
 *     responses:
 *       200: { description: Updated design }
 *       400: { description: Invalid category, id or label }
 *       404: { description: Not found }
 */
router.patch('/api/designs/:category/:id/label', async (req, res) => {
  const cat = CATEGORIES[req.params.category];
  const id = Number(req.params.id);
  const { label } = req.body || {};
  if (!cat) return res.status(400).json({ error: 'Unknown category' });
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid design id' });
  if (!LABELS.includes(label)) return res.status(400).json({ error: `label must be one of: ${LABELS.join(', ')}` });
  try {
    const { rows } = await pool.query(
      `UPDATE ${cat.table} SET label = $1, updated_at = NOW() WHERE id = $2 RETURNING id, label`,
      [label, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Design not found' });
    res.json({ ...rows[0], category: req.params.category });
  } catch (err) {
    console.error('PATCH /api/designs/:category/:id/label failed:', err.message);
    res.status(500).json({ error: 'Failed to update label' });
  }
});

// ---------- editing ----------
// Only these fields can be edited. Image files, product id and designer are fixed.
const IMAGE_TYPES = ['BMP', 'JPG', 'PNG'];
const JACQUARD = ['powerloom', 'rapier', 'handloom'];

const str = (max, required = true) => (v) => {
  if (v == null || String(v).trim() === '') return required ? { error: 'is required' } : { value: null };
  const t = String(v).trim();
  return t.length > max ? { error: `must be at most ${max} characters` } : { value: t };
};
const int = (min, required = true) => (v) => {
  if (v == null || v === '') return required ? { error: 'is required' } : { value: null };
  const n = Number(v);
  return Number.isInteger(n) && n >= min ? { value: n } : { error: `must be a whole number of at least ${min}` };
};
const money = (v) => {
  const n = Number(v);
  return v !== '' && v != null && Number.isFinite(n) && n >= 0
    ? { value: Math.round(n * 100) / 100 }
    : { error: 'must be a number of 0 or more' };
};
const oneOf = (list) => (v) => (list.includes(v) ? { value: v } : { error: `must be one of: ${list.join(', ')}` });
const url = (v) => {
  const r = str(3000)(v);
  if (r.error) return r;
  if (/\s/.test(r.value)) return { error: 'must be one link, without spaces' };
  return /^https?:\/\//i.test(r.value) ? r : { error: 'must start with http:// or https://' };
};

const WEAVE_SCHEMA = {
  name: str(100), cards: int(0), hooks: int(0), epi: int(1), ppi: int(1),
  harness_build: str(30, false), image_type: oneOf(IMAGE_TYPES), label: oneOf(LABELS),
  listing_rate: money, final_price: money, notes: str(2000, false),
};
const SCHEMAS = {
  butta: WEAVE_SCHEMA, brocade: WEAVE_SCHEMA, border: WEAVE_SCHEMA, pallu: WEAVE_SCHEMA, pattern: WEAVE_SCHEMA,
  full_set: {
    name: str(100), jacquard_type: oneOf(JACQUARD), ppi: int(1), body_epi: int(1), border_epi: int(1, false),
    br_hooks: str(100, false), by_hooks: str(100, false), image_type: oneOf(IMAGE_TYPES), label: oneOf(LABELS),
    listing_rate: money, final_price: money,
  },
  free_image: { redirect_url: url, label: oneOf(LABELS), listing_rate: money, final_price: money },
};

// ---------- creating ----------
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const email = (v) => {
  const r = str(255)(v);
  if (r.error) return r;
  return EMAIL.test(r.value) ? { value: r.value.toLowerCase() } : { error: 'must be a valid email address' };
};
// a Full Set is made of several pictures (body, border, pallu ...): the links are kept in one field, separated by spaces
const MAX_PARTS = 20;
const urlList = (v) => {
  const parts = String(v ?? '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return { error: 'is required' };
  if (parts.length > MAX_PARTS) return { error: `can have at most ${MAX_PARTS} pictures` };
  const bad = parts.find((u) => !/^https?:\/\//i.test(u));
  if (bad) return { error: 'every picture link must start with http:// or https://' };
  if (parts.join(' ').length > 6000) return { error: 'is too long' };
  return { value: parts.join(' ') };
};
// extra fields that can be set when creating, but not edited afterwards
const CREATE_ONLY = { designer_email: email, image_url: url, original_image_url: url };
const CREATE_ONLY_FULL_SET = { ...CREATE_ONLY, image_url: urlList, original_image_url: urlList };

/**
 * @openapi
 * /api/designs/{category}:
 *   post:
 *     tags: [Designs]
 *     summary: Create a design in a category
 *     description: >
 *       Send the category's fields plus designer_email (must be an active designer, see GET /api/designers),
 *       image_url and original_image_url.
 *       product_id is generated. label defaults to "new"; Free Image prices default to 0.
 *     parameters:
 *       - { in: path, name: category, required: true, schema: { type: string } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       201: { description: The created design }
 *       400: { description: Validation failed }
 */
router.post('/api/designs/:category', async (req, res) => {
  const key = req.params.category;
  const cat = CATEGORIES[key];
  if (!cat) return res.status(400).json({ error: 'Unknown category' });

  const schema = { ...SCHEMAS[key], ...(key === 'full_set' ? CREATE_ONLY_FULL_SET : CREATE_ONLY) };
  const body = req.body && typeof req.body === 'object' ? req.body : {};

  const unknown = Object.keys(body).filter((k) => !schema[k]);
  if (unknown.length) return res.status(400).json({ error: `Unknown fields: ${unknown.join(', ')}` });

  const fields = {};
  const cols = [];
  const values = [];
  for (const k of Object.keys(schema)) {
    let input = body[k];
    if (input === undefined && k === 'label') input = 'new';
    if (input === undefined && key === 'free_image' && (k === 'listing_rate' || k === 'final_price')) input = 0;
    const r = schema[k](input);
    if (r.error) fields[k] = r.error;
    else { cols.push(k); values.push(r.value); }
  }
  if (!fields.designer_email) {
    const designer = cols.indexOf('designer_email');
    const found = await pool.query('SELECT status FROM designers WHERE LOWER(email) = $1', [values[designer]]);
    if (!found.rowCount) fields.designer_email = 'is not a registered designer';
    else if (found.rows[0].status !== 'active') fields.designer_email = 'is suspended and cannot add designs';
  }
  if (Object.keys(fields).length) return res.status(400).json({ error: 'Validation failed', fields });

  cols.push('product_id');
  values.push(`prod_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`);

  try {
    const { rows } = await pool.query(
      `INSERT INTO ${cat.table} (${cols.join(', ')})
       VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING *`,
      values
    );
    res.status(201).json({ ...rows[0], category: key });
  } catch (err) {
    console.error('POST /api/designs/:category failed:', err.message);
    res.status(err.code === '23514' ? 400 : 500).json({ error: err.code === '23514' ? 'Value not allowed' : 'Failed to create design' });
  }
});

/**
 * @openapi
 * /api/designs/{category}/{id}:
 *   patch:
 *     tags: [Designs]
 *     summary: Edit a design's fields (only the fields sent are changed)
 *     parameters:
 *       - { in: path, name: category, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object, description: Any editable fields of the category, e.g. name, cards, hooks, label, final_price }
 *     responses:
 *       200: { description: The updated design }
 *       400: { description: Validation failed }
 *       404: { description: Not found }
 */
router.patch('/api/designs/:category/:id', async (req, res) => {
  const cat = CATEGORIES[req.params.category];
  const id = Number(req.params.id);
  if (!cat) return res.status(400).json({ error: 'Unknown category' });
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid design id' });

  const schema = SCHEMAS[req.params.category];
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const keys = Object.keys(body);
  if (!keys.length) return res.status(400).json({ error: 'No fields to update' });

  const unknown = keys.filter((k) => !schema[k]);
  if (unknown.length) return res.status(400).json({ error: `Fields cannot be edited: ${unknown.join(', ')}` });

  const fields = {};
  const sets = [];
  const values = [];
  for (const k of keys) {
    const r = schema[k](body[k]);
    if (r.error) fields[k] = r.error;
    else { values.push(r.value); sets.push(`${k} = $${values.length}`); }
  }
  if (Object.keys(fields).length) return res.status(400).json({ error: 'Validation failed', fields });

  try {
    values.push(id);
    const { rows } = await pool.query(
      `UPDATE ${cat.table} SET ${sets.join(', ')}, updated_at = NOW() WHERE id = $${values.length} RETURNING *`,
      values
    );
    if (!rows.length) return res.status(404).json({ error: 'Design not found' });
    res.json({ ...rows[0], category: req.params.category });
  } catch (err) {
    console.error('PATCH /api/designs/:category/:id failed:', err.message);
    res.status(err.code === '23514' ? 400 : 500).json({ error: err.code === '23514' ? 'Value not allowed' : 'Failed to update design' });
  }
});

/**
 * @openapi
 * /api/designs/{category}/{id}:
 *   delete:
 *     tags: [Designs]
 *     summary: Permanently delete a design (cannot be undone)
 *     parameters:
 *       - { in: path, name: category, required: true, schema: { type: string } }
 *       - { in: path, name: id, required: true, schema: { type: integer } }
 *     responses:
 *       204: { description: Deleted }
 *       404: { description: Not found }
 */
router.delete('/api/designs/:category/:id', async (req, res) => {
  const cat = CATEGORIES[req.params.category];
  const id = Number(req.params.id);
  if (!cat) return res.status(400).json({ error: 'Unknown category' });
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'Invalid design id' });
  try {
    const { rowCount } = await pool.query(`DELETE FROM ${cat.table} WHERE id = $1`, [id]);
    if (!rowCount) return res.status(404).json({ error: 'Design not found' });
    res.status(204).end();
  } catch (err) {
    console.error('DELETE /api/designs/:category/:id failed:', err.message);
    res.status(500).json({ error: 'Failed to delete design' });
  }
});

module.exports = router;
