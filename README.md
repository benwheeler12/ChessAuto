# ♛ ChessAuto

A chess puzzle game that isn't about finding moves — it's about **building positions**.

You're given a *semicomplete* chess position: a real position with a few of your
color's pieces removed. Your job is to place those pieces back on the board so
that the position is **winning** for your side. Then you hit **Play it out** and
two chess engines (both Stockfish, running entirely in your browser) battle it
out until the game ends.

**You win if the position you constructed actually wins the game:** your side
delivers checkmate. Draws don't count.

## How to play

1. Pick a **collection** (batches of puzzles, newest first — the newest is the
   default) and a puzzle. Unplayed puzzles are marked with a dot.
2. The missing piece(s) appear in the tray. Rule chips under the puzzle name
   tell you everything that varies per puzzle: who moves first, whether you
   choose from highlighted squares, how many squares are blocked (✕), and how
   many placements win.
3. Drag a piece onto an empty square (or click the piece, then a square).
   Click a placed piece to pick it back up.
   - You can't place a piece on an occupied square, put a pawn on the first or
     last rank, or give an immediate check (the starting position must be legal).
4. Press **▶ Play it out** and watch the engines fight, with a live evaluation
   bar and move list. A **Move speed** slider tunes the playout pace.
5. Win, or press **↺ Adjust & retry** to reposition your pieces and try again.

## Architecture: the puzzle contract

The codebase is split hard along one seam:

- **The UI doesn't know how puzzles are made.** It renders and plays out any
  puzzle that satisfies the **puzzle contract** (`src/puzzle-contract.js`) —
  a self-describing object with the position, the pieces to place, who moves
  first, optional placement constraints (`allowed` / `blocked` squares),
  optional winning placements (`solutions`), and optional precomputed playout
  `lines`. All game semantics (legality, verdicts, rule chips, signatures)
  live in the contract module.
- **Generators don't know about the UI.** They emit **immutable batch files**
  (`src/puzzles/batch-NNN-slug.js`) via `scripts/lib/batches.mjs`. A batch is
  never edited after it ships — new experiments always become a NEW batch
  file, auto-discovered by `src/puzzles/index.js` and shown in the collection
  dropdown, newest first. That makes "what's the newest set of puzzles?"
  always obvious on the site. (The one sanctioned in-place edit is the line
  baker adding playouts / self-healing verdicts.)

So the iteration loop for new puzzle ideas is: write or tweak a generator →
run it with a `--label` → a new batch file appears → it's the default
collection on the next deploy. No UI changes required.

## Running locally

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # production build in dist/
npm test         # validates every batch against the contract + replays lines
```

The Stockfish WASM build is copied from `node_modules` into `public/stockfish/`
automatically (postinstall / predev / prebuild).

## Deploying

The site is fully static — host `dist/` anywhere. A GitHub Actions workflow
(`.github/workflows/deploy.yml`) deploys to GitHub Pages on every push to
`main`; enable it under **Settings → Pages → Source: GitHub Actions**. The
single-threaded Stockfish build is used deliberately so no cross-origin
isolation headers are required.

## How it works

- **Rules & legality**: [chess.js](https://github.com/jhlywa/chess.js) validates
  constructed positions and executes engine moves.
- **Engines**: two [Stockfish 18](https://stockfishchess.org/) WASM workers
  (lite NNUE build, ~7 MB), one per color. Puzzles that ship precomputed
  `lines` need no engine at all — the playout is deterministic playback;
  everything else runs the engines live.
- **Puzzles**: contract objects in `src/puzzles/batch-*.js`; `npm test`
  validates shapes, placement constraints, solution legality, and replays
  every stored line to confirm it agrees with its verdict.

## Generation libraries and the cost model

Puzzle generation is a set of stateless libraries under `scripts/lib/`,
composed by thin CLI scripts — one Node program per run, everything in
memory (no intermediate files between stages):

- **`features.mjs`** — static position features as per-feature functions
  (`material`, `attacks` (tension/contacts/hanging), `pins`, `kingSafety`,
  `passedPawns`, `mobility`) plus `allFeatures()`. All engine-free,
  micro­seconds each; `mobility` dominates at ~3.4ms (two full move
  generations), so `allFeatures` ≈ 3.6ms/position.
- **`corpus.mjs`** — PGN splitting/parsing (`readCorpus`) and in-memory
  position sampling (`samplePositions`), ~3ms/game + ~30µs/ply.
- **`detectors.mjs`** — candidate finders: `hotSectors` (~150µs),
  `legalPlacements` (~4ms for a full-board scan), `removablePieces`,
  `enumerateCombos` (capped).
- **`engine.mjs`** — `EnginePool`: N Stockfish instances in forked child
  processes behind one async API (`evaluate`, `bestMove`), least-busy
  dispatch. `stats()` reports actual call counts and engine-ms per run.
  A call costs its movetime + ~10ms; throughput scales with pool size.
- **`qualify.mjs`** — engine-bound building blocks taking the pool as an
  argument: `evaluatePlayer`, `scanPlacements` (parallel batch scoring),
  `playLine` (verdict-checked playouts with a movetime retry ladder).
- **`pipeline.mjs`** — feature rows with a transparent `.jsonl` cache and
  stage timing logs; **`batches.mjs`** — immutable batch read/write.

Every exported function documents its measured cost; `npm run bench`
re-measures them on a corpus sample (add `--engine` for engine-call
benchmarks) so pipeline estimates stay honest:
**stage cost ≈ positions × Σ(static µs) + engine calls × movetime ÷ pool size.**
Engine calls dominate everything: one deep eval (700ms) costs as much as
~200 fully-featured static positions.

## Generators

The generator CLIs are thin compositions over those libraries. Each mines
real games, qualifies positions with engine verification, and ships a new
batch (they require `--label "…"`, shown in the dropdown; `--out-dir`
redirects output for dry runs, `--pool N` sizes the engine pool, and
`--features <cache.jsonl>` reuses/creates a feature cache):

- `npm run generate:gm -- --label "…"` (`scripts/generate-puzzles.mjs`) —
  replays PGNs in `data/games.pgn` (famous public-domain games), removes one
  of the side-to-move's pieces, and evaluates putting it back on every legal
  square. A position qualifies when placement is *sharp* (few winning
  squares, verified ≥ +3, with clearly losing alternatives). Each qualifying
  position expands into one contract puzzle per supported mode:
  pick-from-candidates, hidden-square (obvious wins blocked), opponent-moves-
  first, and open-board.
- `npm run generate:outliers -- --label "…"` (`scripts/generate-outliers.mjs`)
  — takes feature-outlier positions from the puzzle lab (below), and
  qualifies them under open-board rules: opponent moves first, at most two
  placements on the whole board win. Positions already used by any existing
  batch are skipped automatically.
- `npm run generate:spots -- --label "…"` (`scripts/generate-spots.mjs`)
  — **exact spots**: a group of the player's most ACTIVE pieces (attacking
  enemy pieces, covering the enemy king's zone, defending contested
  friends — via `detectors.activeClusters`) leaves the board and its
  original squares become the only allowed spots. As many pieces in the
  tray as spots on the board; exactly ONE arrangement wins, and every
  wrong arrangement is verified to be at best equal. Selection favors
  sharp positions where the player is even or behind in material, so the
  win lives in the coordination being restored. `--pieces 4` removes four
  pieces (up to 24 arrangements — the origin window automatically narrows
  to just-winning positions to keep the solution unique); `--scatter`
  drops the connectivity requirement so the spots can sit on disparate
  parts of the board, with distant groups ranked higher.
- `npm run generate:sectors -- --label "…"` (`scripts/generate-sectors.mjs`)
  — 3×3 **sector builds**: from positions where the player is winning but
  the opponent moves first, it finds a tactically hot 3×3 zone (pieces of
  both colors, lots of contact), removes the player's 2–3 pieces from that
  zone, and keeps the position only when few ways of putting them back
  inside the zone still win. The player has to assemble a piece structure
  that works together, not just find one strong square.

After generating, `npm run generate:lines -- --file src/puzzles/batch-….js`
optionally precomputes a full engine-vs-engine playout line (moves + evals)
for every reachable placement, using parallel workers. Each line is retried
at increasing think times until its terminal result agrees with the
placement's verdict; stubborn disagreements are self-healed in the batch
(square blocked / solution removed / puzzle dropped). With lines shipped the
playout needs no runtime Stockfish and results are deterministic.

## The playtest-feedback loop

Every puzzle has a review box in the app (and the 👍/👎 on the verdict
banner syncs too). Reviews flow to a Vercel Blob store via
`api/review.js`; a daily Claude Code session reads them back through the
secret-gated `api/reviews.js`, digests the feedback into a proposed
pipeline change, and waits for approval before implementing it and
shipping a new batch. `data/review-cursor.json` records the last review
the loop has processed.

The live deployment is **https://chess-auto.vercel.app** — the daily job
fetches `GET https://chess-auto.vercel.app/api/reviews?since=<cursor>`
(the `REVIEWS_API_BASE_URL` env var, when set, overrides that host).

### Reviewer identity (Google sign-in) and vetting

Reviews are attributed to a verified Google account, and the daily loop
only consumes feedback from an allowlist of vetted reviewers:

- The app shows a **Sign in with Google** button above the review box;
  the resulting ID token rides along with every review POST.
- `api/review.js` verifies the token server-side (audience + expiry +
  verified email, via Google's tokeninfo endpoint) and stores
  `reviewer: {email, name, sub}` on the review. Unauthenticated POSTs
  are rejected with 401.
- `api/reviews.js` returns only reviews whose reviewer email is in
  `REVIEWS_ALLOWED_EMAILS` (comma-separated, case-insensitive); add
  `?all=1` to inspect everything, with a `vetted` flag per review. The
  cursor advances past unvetted reviews too, so they can't wedge the
  loop.

One-time setup:

1. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials):
   create a project → configure the OAuth consent screen (External,
   publish it) → **Create credentials → OAuth client ID → Web
   application**, with authorized JavaScript origins
   `https://chess-auto.vercel.app` (plus `http://localhost:5173` and
   `http://localhost:4173` for local dev). No client secret is needed —
   the ID-token flow is public-client.
2. In the Vercel project, add env vars **`VITE_GOOGLE_CLIENT_ID`** (the
   client ID from step 1 — one var serves both the build-time frontend
   and the serverless verifier) and **`REVIEWS_ALLOWED_EMAILS`** (e.g.
   your own Gmail address), then redeploy.

Until `VITE_GOOGLE_CLIENT_ID` is set, the review box stays in the
legacy anonymous mode, and an empty `REVIEWS_ALLOWED_EMAILS` treats
every review as vetted — so the feature degrades cleanly while it's
being configured.

One-time setup in the Vercel project: create a **Blob** store under
Storage and connect it — newer stores add `BLOB_STORE_ID` and rely on
the `VERCEL_OIDC_TOKEN` Vercel injects into functions at runtime (older
stores add `BLOB_READ_WRITE_TOKEN`; the SDK accepts either). Then add a
`REVIEWS_READ_SECRET` env var (any long random string) and redeploy.
The same secret goes into the Claude Code environment so the daily job
can call `GET /api/reviews?since=<cursor>` with
`Authorization: Bearer <secret>`.

## Puzzle lab (feature analysis)

Groundwork for discovering what makes positions *fun* as puzzles:

- `npm run fetch:games` streams a monthly Lichess database dump and keeps the
  first N games passing quality filters (default: both players ≥2300,
  blitz-or-slower, decisive) — typically a few MB of a ~30 GB file.
- `npm run analyze` samples positions from a PGN and computes cheap static
  features (~3ms/position, no engine): material, tension, hanging pieces,
  pins, king-safety geometry, mobility, passed pawns, checks/captures
  available. Outputs `data/features.jsonl` plus `data/feature-outliers.md`,
  which lists the extreme positions per feature with Lichess analysis links
  for manual fun-testing.

## Credits

Piece graphics are the classic
[cburnett chess set](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard)
by Colin M.L. Burnett (with contributions by Rfc1394), licensed
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), extracted from
the [cm-chessboard](https://github.com/shaack/cm-chessboard) sprite by Stefan
Haack. (Chess.com's own piece sets are proprietary; this is the well-known
freely licensed set used by Wikipedia and lichess.)
