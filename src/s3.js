require('dotenv').config({ quiet: true });
const { S3Client, ListObjectsV2Command, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const { AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_BUCKET_NAME, AWS_REGION } = process.env;

const PREFIX = 'images/';
const COURSE_THUMBNAIL_FOLDER = 'course-thumbnails'; // under images/ (so it is publicly readable) but hidden from the design image library
const CONTENT_TYPES = {
  bmp: 'image/bmp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};
const extOf = (name) => (name.split('.').pop() || '').toLowerCase();
const isImage = (name) => Object.hasOwn(CONTENT_TYPES, extOf(name));

const configured = Boolean(AWS_ACCESS_KEY_ID && AWS_SECRET_ACCESS_KEY && AWS_BUCKET_NAME && AWS_REGION);

const client = configured
  ? new S3Client({
      region: AWS_REGION,
      credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY },
    })
  : null;

// same URL shape the existing designs use: the "/" in the key is encoded as %2F
const urlFor = (key) => `https://${AWS_BUCKET_NAME}.s3.${AWS_REGION}.amazonaws.com/${encodeURIComponent(key)}`;

// "images/1761469291797-SIM.bmp" -> "SIM.bmp"
const displayName = (key) => key.slice(PREFIX.length).replace(/^\d{10,}-(?:[a-z0-9]{3}-)?/, '');

// Listing the whole prefix takes several S3 calls, so the result is cached.
// When it gets old, the old list is served at once while a fresh one loads in the
// background (stale-while-revalidate), so nobody waits for S3 on a normal visit.
let cache = { at: 0, items: [] };
let version = 0; // bumped by every upload so an in-flight listing can't hide it
let inflight = null;
const TTL_MS = 60_000;

async function fetchAll() {
  const items = [];
  let token;
  do {
    const r = await client.send(
      new ListObjectsV2Command({ Bucket: AWS_BUCKET_NAME, Prefix: PREFIX, ContinuationToken: token })
    );
    for (const o of r.Contents || []) {
      if (o.Key.endsWith('/') || !isImage(o.Key)) continue;
      if (o.Key.startsWith(`${PREFIX}${COURSE_THUMBNAIL_FOLDER}/`)) continue;
      items.push({
        key: o.Key,
        name: displayName(o.Key),
        size: o.Size,
        lastModified: o.LastModified,
        url: urlFor(o.Key),
      });
    }
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  items.sort((a, b) => b.lastModified - a.lastModified);
  return items;
}

function refreshCache() {
  if (!inflight) {
    const startedAt = version;
    inflight = fetchAll()
      .then((items) => {
        // an upload happened meanwhile: this listing may miss it, so keep it marked stale
        cache = { at: startedAt === version ? Date.now() : 0, items };
        return items;
      })
      .finally(() => { inflight = null; });
  }
  return inflight;
}

async function listImages({ refresh = false } = {}) {
  const hasItems = cache.items.length > 0;
  const fresh = hasItems && Date.now() - cache.at < TTL_MS;
  if (!refresh && fresh) return cache.items;
  if (!refresh && hasItems && cache.at !== 0) {
    refreshCache().catch((e) => console.error('Background image refresh failed:', e.message));
    return cache.items; // slightly old, but instant
  }
  return refreshCache(); // first load, forced refresh, or right after an upload
}

// call once at startup so the first admin visit is already warm
const warm = () => (configured ? refreshCache().catch((e) => console.error('Image cache warm-up failed:', e.message)) : null);

// Always a brand-new key, so an upload can never overwrite an existing file.
async function uploadImage({ originalname, buffer }, folder = '') {
  const ext = extOf(originalname);
  const base = originalname.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'image';
  const rand = Math.random().toString(36).slice(2, 5);
  const key = `${PREFIX}${folder ? `${folder}/` : ''}${Date.now()}-${rand}-${base}.${ext}`;
  await client.send(
    new PutObjectCommand({ Bucket: AWS_BUCKET_NAME, Key: key, Body: buffer, ContentType: CONTENT_TYPES[ext] })
  );
  version += 1;
  cache.at = 0; // the next list waits for a fresh listing that includes the new file
  return { key, name: `${base}.${ext}`, size: buffer.length, url: urlFor(key) };
}

/**
 * Course pictures imported from the old database are links that were signed for 7 days and have long expired
 * (and their bucket is private). This returns a freshly signed link for such an S3 address, valid for 6 hours.
 * Any other address (or no address) is returned unchanged, and so is an address we cannot sign.
 */
async function freshUrl(url) {
  if (!url || !client) return url;
  let u;
  try { u = new URL(url); } catch { return url; }
  const m = /^([a-z0-9.-]+)\.s3[.-]([a-z0-9-]+)\.amazonaws\.com$/i.exec(u.hostname);
  if (!m || !u.searchParams.has('X-Amz-Signature')) return url; // only the signed, expired kind
  try {
    const key = decodeURIComponent(u.pathname.slice(1));
    const signer = m[2] === AWS_REGION ? client : new S3Client({ region: m[2], credentials: { accessKeyId: AWS_ACCESS_KEY_ID, secretAccessKey: AWS_SECRET_ACCESS_KEY } });
    return await getSignedUrl(signer, new GetObjectCommand({ Bucket: m[1], Key: key }), { expiresIn: 6 * 60 * 60 });
  } catch (err) {
    console.error('freshUrl failed:', err.message);
    return url;
  }
}

module.exports = {
  freshUrl, configured, listImages, uploadImage, isImage, warm, CONTENT_TYPES, COURSE_THUMBNAIL_FOLDER };
