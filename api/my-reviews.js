// GET /api/my-reviews — returns the signed-in reviewer's OWN latest marks
// per puzzle, so a second device (or a fresh session) can show what they've
// already rated instead of letting them unknowingly re-rate. Authenticated
// by the reviewer's Google ID token:
//   Authorization: Bearer <google-id-token>
// Response: { marks: { [puzzleId]: { rating, quality, difficulty } } }
// Only the caller's own reviews are consulted (matched by Google sub), and
// only the structured fields are returned — no text, no other reviewers.

import { list, get } from '@vercel/blob';
import { verifyGoogleIdToken } from './review.js';

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
  const clientId = process.env.VITE_GOOGLE_CLIENT_ID;
  if (!clientId) {
    return res.status(404).json({ error: 'sign-in not configured' });
  }
  const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
  const me = await verifyGoogleIdToken(token, clientId);
  if (!me) {
    return res.status(401).json({ error: 'Google sign-in required' });
  }

  try {
    const entries = [];
    let cursor;
    do {
      const page = await list({ prefix: 'reviews/', cursor, limit: 1000 });
      for (const blob of page.blobs) {
        const data = await readBlobJson(blob);
        if (!data?.puzzleId) continue;
        if ((data.reviewer?.sub ?? null) !== me.sub) continue;
        entries.push({ key: blob.pathname, data });
      }
      cursor = page.cursor;
    } while (cursor);

    // Latest review per puzzle wins wholesale — every post from the app is
    // a full snapshot of that puzzle's marks.
    entries.sort((a, b) => (a.key < b.key ? -1 : 1));
    const marks = {};
    for (const { data } of entries) {
      const snapshot = {
        rating: data.rating ?? null,
        quality: data.quality ?? null,
        difficulty: data.difficulty ?? null,
      };
      if (snapshot.rating == null && snapshot.quality == null && snapshot.difficulty == null) {
        delete marks[data.puzzleId];
      } else {
        marks[data.puzzleId] = snapshot;
      }
    }
    return res.status(200).json({ marks });
  } catch (err) {
    return res.status(500).json({ error: `blob list failed: ${err.message}` });
  }
}
