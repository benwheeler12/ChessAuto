// GET /api/reviews?since=<key> — returns reviews newer than the cursor,
// oldest first, for the daily feedback-digest job. Requires
//   Authorization: Bearer $REVIEWS_READ_SECRET
// Each review carries a `key` (its blob filename, timestamp-prefixed); the
// caller persists the last processed key as its cursor — see
// data/review-cursor.json in the repo.

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

async function collect(since) {
  const reviews = [];
  let cursor;
  do {
    const page = await list({ prefix: 'reviews/', cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const key = blob.pathname.slice('reviews/'.length);
      if (since && key <= since) continue;
      const data = await readBlobJson(blob);
      if (data) reviews.push({ ...data, key });
    }
    cursor = page.cursor;
  } while (cursor);

  reviews.sort((a, b) => (a.key < b.key ? -1 : 1));
  return {
    reviews,
    cursor: reviews.length ? reviews[reviews.length - 1].key : (since || null),
  };
}
