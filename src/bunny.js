// Course videos live on Bunny Stream. The admin's browser uploads the file straight to Bunny (so a big video never
// passes through this server): the server creates the video on Bunny, signs a resumable (TUS) upload for it, and
// afterwards reports how far Bunny has got with encoding. Same flow the course admin server uses.
const crypto = require('crypto');

const apiBase = () => process.env.BUNNY_API_BASE || 'https://video.bunnycdn.com';
const key = () => process.env.BUNNY_STREAM_API_KEY;
const library = () => process.env.BUNNY_LIBRARY_ID;
const cdn = () => (process.env.BUNNY_CDN_URL || '').replace(/\/+$/, '');
const tusEndpoint = () => process.env.BUNNY_TUS_ENDPOINT || 'https://video.bunnycdn.com/tusupload';

const isConfigured = () => Boolean(key() && library() && cdn());

class BunnyError extends Error {}

async function call(path, { method = 'GET', body } = {}) {
  if (!isConfigured()) throw new BunnyError('Video upload is not set up on the server (Bunny settings are missing)');
  const res = await fetch(`${apiBase()}/library/${library()}${path}`, {
    method,
    headers: { AccessKey: key(), Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new BunnyError(`Bunny answered ${res.status} for ${method} ${path.split('?')[0]}`);
  return res.status === 204 ? null : res.json().catch(() => ({}));
}

/** the collection the course videos are filed under (created the first time) */
async function collectionId() {
  const name = process.env.BUNNY_COLLECTION_NAME || 'course-videos';
  const list = await call(`/collections?search=${encodeURIComponent(name)}&itemsPerPage=100`);
  const found = (list.items || []).find((c) => c.name === name);
  if (found) return found.guid;
  return (await call('/collections', { method: 'POST', body: { name } })).guid;
}

/** makes the (empty) video on Bunny and returns its id */
async function createVideo(title) {
  const guid = (await call('/videos', { method: 'POST', body: { title: String(title).slice(0, 255), collectionId: await collectionId() } })).guid;
  if (!guid) throw new BunnyError('Bunny did not return a video id');
  return guid;
}

/** what the browser needs to upload `videoId` directly: sha256(libraryId + apiKey + expires + videoId) */
function tusSignature(videoId, validSeconds = 6 * 3600) {
  const expires = Math.floor(Date.now() / 1000) + validSeconds;
  const signature = crypto.createHash('sha256').update(`${library()}${key()}${expires}${videoId}`).digest('hex');
  return { endpoint: tusEndpoint(), signature, expires, libraryId: String(library()), videoId };
}

const STATUS = { 0: 'created', 1: 'uploaded', 2: 'processing', 3: 'processing', 4: 'completed', 5: 'completed', 6: 'failed' };

/** where Bunny is with a video: 'created' (nothing uploaded yet) ... 'completed' (ready to play) or 'failed' */
async function getStatus(videoId) {
  const v = await call(`/videos/${encodeURIComponent(videoId)}`);
  const res = Array.isArray(v.availableResolutions) ? v.availableResolutions
    : typeof v.availableResolutions === 'string' ? v.availableResolutions.split(',').map((r) => r.trim()).filter(Boolean) : [];
  return {
    bunny_video_id: videoId,
    status: STATUS[v.status] ?? 'processing',
    progress: v.encodeProgress || 0,
    duration_seconds: Math.round(v.length || 0),
    video_url: `${cdn()}/${videoId}/playlist.m3u8`,
    thumbnail_url: `${cdn()}/${videoId}/thumbnail.jpg`,
    available_resolutions: res,
  };
}

// This module only ever creates a new video and reads its status. It never changes or deletes anything that exists on Bunny.
module.exports = { isConfigured, createVideo, tusSignature, getStatus, BunnyError };
