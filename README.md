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

**Grandmaster puzzles** (the main mode): a sharp position from a real
grandmaster game is shown with one of your pieces removed, and 2–3 candidate
squares are highlighted. Exactly one of them makes your position completely
winning — the others lose. Click a square, press play, and find out which kind
you picked.

**Classic free-placement puzzles**: the missing pieces appear in a tray and you
may put them anywhere legal.

1. Pick a puzzle — the missing pieces appear in the tray.
2. Drag a piece onto an empty square (or click the piece, then a square).
   Click a placed piece to pick it back up.
   - You can't place a piece on an occupied square, put a pawn on the first or
     last rank, or give an immediate check (the starting position must be legal).
3. Press **▶ Play it out** and watch the engines fight, with a live evaluation
   bar and move list.
4. Win, or press **↺ Adjust & retry** to reposition your pieces and try again.

## Running locally

```bash
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # production build in dist/
npm test         # validates all puzzle definitions
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
  (lite NNUE build, ~7 MB), one per color, at 300 ms per move.
- **Puzzles**: defined in `src/puzzles.js` as `{ fen, player, place }` —
  adding a new puzzle is a single object; `npm test` sanity-checks them all.

## Generating puzzles from grandmaster games

`npm run generate` mines real games for candidate-square puzzles
(`scripts/generate-puzzles.mjs`):

1. Replays each PGN in `data/games.pgn` and samples middlegame positions,
   skipping ones that were already completely one-sided.
2. Removes one of the side-to-move's pieces (queens and rooks first) and has
   Stockfish evaluate putting it back on **every** legal empty square.
3. Keeps a position only when placement is *sharp*: at most a handful of
   squares win, at least one is completely winning (≥ +3 after deep
   verification), and there are plausible placements that are clearly losing
   (≤ −3).
4. Emits `src/generated-puzzles.js` with 2–3 candidate squares per puzzle —
   exactly one winning — plus source-game metadata and the verified evals.

Point it at any PGN collection with
`node scripts/generate-puzzles.mjs --in path/to/games.pgn`; tune with
`--max`, `--per-game`, `--shallow` (ms per scan eval) and `--deep`
(ms per verification eval). The bundled `data/games.pgn` holds famous
public-domain games (Morphy, Anderssen, Fischer, Rubinstein, Kasparov…).

## Credits

Piece graphics are the classic
[cburnett chess set](https://commons.wikimedia.org/wiki/Category:SVG_chess_pieces/Standard)
by Colin M.L. Burnett (with contributions by Rfc1394), licensed
[CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/), extracted from
the [cm-chessboard](https://github.com/shaack/cm-chessboard) sprite by Stefan
Haack. (Chess.com's own piece sets are proprietary; this is the well-known
freely licensed set used by Wikipedia and lichess.)
