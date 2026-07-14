// GET /api/reviews?since=<key> — returns reviews newer than the cursor,
// oldest first, for the daily feedback-digest job. Requires
//   Authorization: Bearer $REVIEWS_READ_SECRET
// Each review carries a `key` (its blob filename, timestamp-prefixed); the
// caller persists the last processed key as its cursor — see
// data/review-cursor.json in the repo.
//
// Vetting: when REVIEWS_ALLOWED_EMAILS is set (comma-separated emails),
// only reviews from those Google-verified reviewers are returned; pass
// ?all=1 to see everything (each review carries `vetted` either way). The
// cursor always advances past every scanned review, vetted or not, so
// unvetted reviews never wedge the loop.

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
  const includeAll = req.query.all === '1';

  try {
    return res.status(200).json(await collect(since, includeAll));
  } catch (err) {
    return res.status(500).json({ error: `blob list failed: ${err.message}` });
  }
}

const allowlist = () =>
  (process.env.REVIEWS_ALLOWED_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

async function collect(since, includeAll) {
  const allowed = allowlist();
  const vetted = (r) => !allowed.length || allowed.includes(r.reviewer?.email ?? '');
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
      const isVetted = vetted(data);
      if (!isVetted && !includeAll) continue;
      reviews.push({ ...data, key, vetted: isVetted });
    }
    cursor = page.cursor;
  } while (cursor);

  reviews.sort((a, b) => (a.key < b.key ? -1 : 1));
  return { reviews, cursor: newest };
}
