# ♛ ChessAuto

A chess puzzle game that isn't about finding moves — it's about **building positions**.

You're given a *semicomplete* chess position: a real position with a few of your
color's pieces removed. Your job is to place those pieces back on the board so
that the position is **winning** for your side. Then you hit **Play it out** and
two chess engines (both Stockfish, running entirely in your browser) battle it
out for 20–30 moves.

**You win if the position you constructed actually wins the game:** your side
delivers checkmate, or the engines reach the move cap and adjudicate the final
position as decisively winning (at least +3 pawns) for your color. Draws and
unclear positions don't count.

## How to play

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
- **Adjudication**: if no checkmate occurs within the puzzle's move cap, a
  deeper 2-second evaluation of the final position decides the result.
- **Puzzles**: defined in `src/puzzles.js` as `{ fen, player, place, moveCap }` —
  adding a new puzzle is a single object; `npm test` sanity-checks them all.
