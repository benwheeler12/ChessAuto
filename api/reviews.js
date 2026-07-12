// GET /api/reviews?since=<key> — returns reviews newer than the cursor,
// oldest first, for the daily feedback-digest job. Requires
//   Authorization: Bearer $REVIEWS_READ_SECRET
// Each review carries a `key` (its blob filename, timestamp-prefixed); the
// caller persists the last processed key as its cursor — see
// data/review-cursor.json in the repo.

import { list } from '@vercel/blob';

export default async function handler(req, res) {
  const auth = req.headers.authorization ?? '';
  const secret = process.env.REVIEWS_READ_SECRET;
  if (!secret || auth !== `Bearer ${secret}`) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  const since = typeof req.query.since === 'string' ? req.query.since : '';

  const reviews = [];
  let cursor;
  do {
    const page = await list({ prefix: 'reviews/', cursor, limit: 1000 });
    for (const blob of page.blobs) {
      const key = blob.pathname.slice('reviews/'.length);
      if (since && key <= since) continue;
      const data = await fetch(blob.url).then((r) => r.json()).catch(() => null);
      if (data) reviews.push({ ...data, key });
    }
    cursor = page.cursor;
  } while (cursor);

  reviews.sort((a, b) => (a.key < b.key ? -1 : 1));
  return res.status(200).json({
    reviews,
    cursor: reviews.length ? reviews[reviews.length - 1].key : (since || null),
  });
}
