// POST /api/review — accepts one puzzle review from the web app and appends
// it to the Vercel Blob store as reviews/<timestamp>-<rand>.json. Same-origin
// only in practice (the site and this function share a domain); size-capped
// and shape-validated. Writing requires BLOB_READ_WRITE_TOKEN, which Vercel
// injects once a Blob store is connected to the project.

import { put } from '@vercel/blob';

/** Write with whichever access mode this store supports (newer stores are
 * private; legacy stores are public-only). */
async function putAdaptive(key, body, contentType) {
  try {
    return await put(key, body, { access: 'private', contentType });
  } catch (err) {
    if (/public store/i.test(err.message ?? '')) {
      return put(key, body, { access: 'public', contentType });
    }
    throw err;
  }
}

const MAX_TEXT = 1000;

/** Verify a Google ID token against our OAuth client id and return the
 * reviewer identity, or null when the token is missing/invalid/expired.
 * Uses Google's tokeninfo endpoint — one HTTPS round-trip, fine at review
 * volume, and Google does the signature check. Shared with my-reviews.js. */
export async function verifyGoogleIdToken(idToken, clientId) {
  if (typeof idToken !== 'string' || !idToken) return null;
  try {
    const res = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!res.ok) return null;
    const claims = await res.json();
    if (claims.aud !== clientId) return null;
    if (Number(claims.exp) * 1000 < Date.now()) return null;
    if (String(claims.email_verified) !== 'true' || !claims.email) return null;
    return {
      email: claims.email.toLowerCase(),
      name: claims.name ?? null,
      sub: claims.sub ?? null,
    };
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  const {
    puzzleId, batchId, rating = null, text = '', clientId = null, idToken = null,
    quality = null, difficulty = null,
  } = req.body ?? {};

  // With an OAuth client configured, every review must carry a verified
  // Google identity. Without one (not yet set up), reviews stay anonymous.
  const googleClientId = process.env.VITE_GOOGLE_CLIENT_ID;
  let reviewer = null;
  if (googleClientId) {
    reviewer = await verifyGoogleIdToken(idToken, googleClientId);
    if (!reviewer) {
      return res.status(401).json({ error: 'Google sign-in required' });
    }
  }
  if (typeof puzzleId !== 'string' || !/^b\d{3}-\d+$/.test(puzzleId)) {
    return res.status(400).json({ error: 'bad puzzleId' });
  }
  if (typeof text !== 'string' || text.length > MAX_TEXT) {
    return res.status(400).json({ error: 'bad text' });
  }
  if (!text.trim() && rating == null && quality == null && difficulty == null) {
    return res.status(400).json({ error: 'empty review' });
  }
  if (rating != null && rating !== 1 && rating !== -1) {
    return res.status(400).json({ error: 'bad rating' });
  }
  // Curation marks for the hand-picking workflow (see the curate buttons in
  // the app). Null clears a previously sent mark.
  if (quality != null && !['great', 'good', 'bad'].includes(quality)) {
    return res.status(400).json({ error: 'bad quality' });
  }
  if (difficulty != null && !['easy', 'medium', 'hard'].includes(difficulty)) {
    return res.status(400).json({ error: 'bad difficulty' });
  }

  const review = {
    puzzleId,
    batchId: typeof batchId === 'string' ? batchId.slice(0, 16) : null,
    rating,
    text: text.trim(),
    quality,
    difficulty,
    clientId: typeof clientId === 'string' ? clientId.slice(0, 40) : null,
    reviewer,
    createdAt: new Date().toISOString(),
  };
  const key = `reviews/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  try {
    await putAdaptive(key, JSON.stringify(review), 'application/json');
  } catch (err) {
    // Surface storage problems as JSON so misconfiguration is diagnosable
    // from the client instead of an opaque FUNCTION_INVOCATION_FAILED.
    return res.status(500).json({ error: `blob write failed: ${err.message}` });
  }
  return res.status(200).json({ ok: true });
}
