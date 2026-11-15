// Shopper login tokens: a standard HS256 JWT signed with JWT_SECRET (no extra dependency).
const crypto = require('crypto');

const TTL_SECONDS = 7 * 24 * 60 * 60; // a login lasts a week
const b64 = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 16) throw new Error('JWT_SECRET is not set (use at least 16 random characters)');
  return s;
}

const sign = (data) => crypto.createHmac('sha256', secret()).update(data).digest('base64url');

function signToken(customerId) {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64({ sub: String(customerId), exp: Math.floor(Date.now() / 1000) + TTL_SECONDS });
  return `${head}.${body}.${sign(`${head}.${body}`)}`;
}

/** @returns the customer id (string) or null when the token is missing, forged or expired */
function verifyToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = Buffer.from(sign(`${parts[0]}.${parts[1]}`));
  const given = Buffer.from(parts[2]);
  if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) return null;
  try {
    const { sub, exp } = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
    return exp > Math.floor(Date.now() / 1000) ? sub : null;
  } catch { return null; }
}

/** Express middleware: sets req.customerId, or answers 401 */
function requireUser(req, res, next) {
  let id;
  try { id = verifyToken((req.headers.authorization || '').replace(/^Bearer\s+/i, '')); }
  catch (err) { console.error(err.message); return res.status(500).json({ error: 'Login is not configured on the server' }); }
  if (!id) return res.status(401).json({ error: 'Please log in to continue' });
  req.customerId = id;
  next();
}

module.exports = { signToken, verifyToken, requireUser };
