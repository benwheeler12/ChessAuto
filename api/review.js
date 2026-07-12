// POST /api/review — accepts one puzzle review from the web app and appends
// it to the Vercel Blob store as reviews/<timestamp>-<rand>.json. Same-origin
// only in practice (the site and this function share a domain); size-capped
// and shape-validated. Writing requires BLOB_READ_WRITE_TOKEN, which Vercel
// injects once a Blob store is connected to the project.

import { put } from '@vercel/blob';

const MAX_TEXT = 1000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const { puzzleId, batchId, rating = null, text = '', clientId = null } = req.body ?? {};
  if (typeof puzzleId !== 'string' || !/^b\d{3}-\d+$/.test(puzzleId)) {
    return res.status(400).json({ error: 'bad puzzleId' });
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT) {
    return res.status(400).json({ error: 'bad text' });
  }
  if (!text.trim() && rating == null) {
    return res.status(400).json({ error: 'empty review' });
  }
  if (rating != null && rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'bad rating' });
  }

  const review = {
    puzzleId,
    batchId: typeof batchId === 'string' ? batchId.slice(0, 16) : null,
    rating,
    text: text.trim(),
    clientId: typeof clientId === 'string' ? clientId.slice(0, 40) : null,
    createdAt: new Date().toISOString(),
  };
  const key = `reviews/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  await put(key, JSON.stringify(review), {
    access: 'public', // unguessable URL; the listing itself is token-gated
    contentType: 'application/json',
  });
  return res.status(200).json({ ok: true });
}
