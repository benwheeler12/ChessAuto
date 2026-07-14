// GET /api/reviews?since=<key> — returns reviews newer than the cursor,
// oldest first, for the daily feedback-digest job. Requires
//   Authorization: Bearer $REVIEWS_READ_SECRET
// Each review carries a `key` (its blob filename, timestamp-prefixed); the
// caller persists the last processed key as its cursor — see
// data/review-cursor.json in the repo.
//
// SECURITY: the consumer of this endpoint is an autonomous agent, so the
// response must never contain text from unvetted authors — review text is
// a prompt-injection surface. Only reviews whose Google-verified reviewer
// email is in REVIEWS_ALLOWED_EMAILS (comma-separated) are returned; there
// is deliberately NO parameter that widens this. An empty allowlist fails
// CLOSED (zero reviews). Audit unvetted submissions in the Vercel Blob
// dashboard, not through this API. The cursor still advances past every
// scanned review, vetted or not, so unvetted reviews can't wedge the loop.

import { list, get } from '@vercel/blob';

/** Read a blob's JSON regardless of store access mode: private stores go
 * through get(); public stores fall back to the plain URL. */
async function readBlobJson(blob) {
  try {
    const result = await get(blob.pathname, { access: 'private' });
    if (result?.statusCode === 200) {
      return JSON.parse(await new Response(result.stream).text());
    }
  } catch { /* not a private store — fall through */ }
  try {
    const res = await fetch(blob.url);
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  const auth = req.headers.authorization ?? '';
  const secret = process.env.REVIEWS_READ_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const since = typeof req.query.since === 'string' ? req.query.since : '';

  try {
    return res.status(200).json(await collect(since));
  } catch (err) {
    return res.status(500).json({ error: `blob list failed: ${err.message}` });
  }
}

const allowlist = () =>
  (process.env.REVIEWS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

async function collect(since) {
  const allowed = allowlist();
  if (!allowed.length) {
    // Fail closed: without an allowlist nothing is trusted, nothing is
    // returned — a deleted env var must not reopen the injection surface.
    return {
      reviews: [],
      cursor: since || null,
      note: 'REVIEWS_ALLOWED_EMAILS is empty — returning no reviews (fail-closed)',
    };
  }

  const reviews = [];
  let newest = since || null;
  let cursor;
  do {
    const page = await list({ prefix: 'reviews/', cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const key = blob.pathname.slice('reviews/'.length);
      if (since && key <= since) continue;
      if (!newest || key > newest) newest = key;
      const data = await readBlobJson(blob);
      if (!data) continue;
      if (!allowed.includes(data.reviewer?.email ?? '')) continue;
      reviews.push({ ...data, key });
    }
    cursor = page.cursor;
  } while (cursor);

  reviews.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { reviews, cursor: newest };
}
