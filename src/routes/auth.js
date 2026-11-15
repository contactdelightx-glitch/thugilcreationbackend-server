const { Router } = require('express');
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { signToken, requireUser } = require('../auth');

const router = Router();

// slow down password guessing: 8 tries per email and address every 15 minutes
const WINDOW_MS = 15 * 60 * 1000;
const MAX_TRIES = 8;
const tries = new Map();
function tooMany(key) {
  const now = Date.now();
  const hit = (tries.get(key) || []).filter((t) => now - t < WINDOW_MS);
  tries.set(key, hit);
  return hit.length >= MAX_TRIES;
}
const note = (key) => tries.set(key, [...(tries.get(key) || []), Date.now()]);
// compared against when the email is unknown, so a wrong email and a wrong password take the same time
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', 10);

const publicUser = (u) => ({ customer_id: u.customer_id, full_name: u.full_name, email: u.email, phone: u.phone });

/**
 * @openapi
 * /api/auth/login:
 *   post:
 *     tags: [Auth]
 *     summary: Log a shopper in with email and password
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties: { email: { type: string }, password: { type: string } }
 *     responses:
 *       200: { description: "{ token, user }" }
 *       401: { description: Wrong email or password }
 *       403: { description: Account is not active }
 *       429: { description: Too many attempts }
 */
router.post('/api/auth/login', async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  if (!email || !password) return res.status(400).json({ error: 'Enter your email and password' });

  const key = `${req.ip}|${email}`;
  if (tooMany(key)) return res.status(429).json({ error: 'Too many attempts. Please try again in a few minutes.' });

  try {
    const { rows } = await pool.query(
      'SELECT customer_id, full_name, email, phone, password_hash, status FROM users WHERE LOWER(email) = $1', [email]
    );
    const user = rows[0];
    const ok = await bcrypt.compare(password, user ? user.password_hash : DUMMY_HASH);
    if (!user || !ok) { note(key); return res.status(401).json({ error: 'Wrong email or password' }); }
    if (user.status !== 'active') return res.status(403).json({ error: 'This account is not active. Please contact us.' });
    tries.delete(key);
    res.json({ token: signToken(user.customer_id), user: publicUser(user) });
  } catch (err) {
    console.error('POST /api/auth/login failed:', err.message);
    res.status(500).json({ error: 'Could not log in. Please try again.' });
  }
});

/**
 * @openapi
 * /api/auth/me:
 *   get:
 *     tags: [Auth]
 *     summary: The logged-in shopper (also checks the saved login is still valid)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: The shopper }
 *       401: { description: Not logged in }
 */
router.get('/api/auth/me', requireUser, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT customer_id, full_name, email, phone, status FROM users WHERE customer_id = $1', [req.customerId]);
    if (!rows[0] || rows[0].status !== 'active') return res.status(401).json({ error: 'Please log in to continue' });
    res.json({ user: publicUser(rows[0]) });
  } catch (err) {
    console.error('GET /api/auth/me failed:', err.message);
    res.status(500).json({ error: 'Failed to load your account' });
  }
});

module.exports = router;
