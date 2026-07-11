// GM-game puzzle miner: removes one of the side-to-move's pieces from
// sharp positions in classic games and finds sharp placement puzzles. A
// thin composition over the generation libraries — single process, one
// shared EnginePool, all in memory.
//
// For each sampled position, one piece is removed and Stockfish evaluates
// putting it back on every legal empty square, once with the player to move
// and once with the opponent to move. A position qualifies when placement
// is sharp: few squares win, one deep-verifies as completely winning, and
// (for the pick-a-square mode) there are verified-losing decoys. Each
// qualifying position expands into one contract puzzle per supported mode
// via lib/legacy-transform.mjs.
//
// Usage: node scripts/generate-puzzles.mjs --label "My batch label"
//   [--in data/games.pgn] [--max 12] [--per-game 2]
//   [--shallow 80] [--deep 700] [--pool 3] [--out-dir src/puzzles]
//
// COST (pool of 3): each surviving position runs up to two ~60-square
// shallow scans (80ms each) plus ~10 deep evals (700ms) ≈ 15–25s; failed
// origin gates cost one shallow eval.

import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { stageTimer } from './lib/pipeline.mjs';
import { readCorpus, samplePositions } from './lib/corpus.mjs';
import { removablePieces, legalPlacements } from './lib/detectors.mjs';
import { scanPlacements as scanCandidates, evaluatePlayer } from './lib/qualify.mjs';
import { legacyToContract } from './lib/legacy-transform.mjs';
import { writeBatch } from './lib/batches.mjs';
import { fenToMap, buildFen } from '../src/fen.js';
import { isLegalStart } from '../src/puzzle-contract.js';

const WIN_CP = 300; // "completely winning" for the player
const LOSS_CP = -300; // "clearly losing" for the player
const SHALLOW_WIN_CP = 350; // pre-filter margins (shallow search is noisy)
const SHALLOW_LOSS_CP = -250;
const EXCLUDE_VERIFY_CP = 50; // shallow gray zone that gets a deep look
const EXCLUDE_CP = 150; // deep-verified near-winners get blocked/counted
const MAX_SHALLOW_WINNERS = 6; // more = placement isn't precise/sharp
const ORIGIN_EVAL_LIMIT = 700; // skip positions that were already blowouts
const MAX_P4_SOLUTIONS = 2; // open-board mode allows at most this many
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };

// ---- Options ----
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const IN_FILE = opt('in', 'data/games.pgn');
const MAX_PUZZLES = Number(opt('max', 12));
const PER_GAME = Number(opt('per-game', 2));
const SHALLOW_MS = Number(opt('shallow', 80));
const DEEP_MS = Number(opt('deep', 700));
const POOL_SIZE = Number(opt('pool', 3));
const OUT_DIR = opt('out-dir', 'src/puzzles');
const LABEL = opt('label', null);
if (!LABEL) {
  console.error('A --label for the new batch is required (shown in the collection dropdown).');
  process.exit(1);
}

const squareDistance = (a, b) => Math.max(
  Math.abs(a.charCodeAt(0) - b.charCodeAt(0)),
  Math.abs(Number(a[1]) - Number(b[1])),
);

// ---- Mining ----
const pool = await new EnginePool(POOL_SIZE).init();
const games = readCorpus(IN_FILE);
const mineLog = stageTimer('mine');
const puzzles = [];
const seen = new Set();

for (const parsed of games) {
  if (puzzles.length >= MAX_PUZZLES) break;
  const label = `${parsed.white} vs ${parsed.black}, ${parsed.headers.Event ?? '?'} ${(parsed.headers.Date ?? '').slice(0, 4)}`;
  console.error(`\n=== ${label} (${parsed.moves.length} plies)`);
  const positions = [...samplePositions(parsed, { firstPly: 16, lastPlyMargin: 6, step: 3 })]
    .map((s) => ({ fen: s.fen, moveNumber: s.moveNo, ply: s.ply }));

  let fromThisGame = 0;
  for (const [posIdx, pos] of positions.entries()) {
    if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

    const player = pos.fen.split(' ')[1];
    const opponent = player === 'w' ? 'b' : 'w';
    const map = fenToMap(pos.fen);

    // Skip positions that were already completely one-sided.
    const originCp = await pool.evaluate(pos.fen, { movetime: SHALLOW_MS });
    if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) continue;

    for (const [origin, piece] of removablePieces(map, player, posIdx, 3)) {
      if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

      const baseMap = { ...map };
      delete baseMap[origin];
      const key = `${buildFen(baseMap, player)}|${piece.type}`;
      if (seen.has(key)) continue;

      /**
       * Scan every legal placement with `turn` to move; null unless sharp:
       * few squares win, one deep-verifies as completely winning, and every
       * other (near-)winner lands in the exclusion list.
       */
      const scanPlacements = async (turn) => {
        const candidates = legalPlacements(baseMap, piece, turn);
        const scans = (await scanCandidates(pool, candidates, player, { movetime: SHALLOW_MS }))
          .map((s) => ({ sq: s.square, fen: s.fen, cp: s.cp }));
        const shallowWinners = scans.filter((s) => s.cp >= SHALLOW_WIN_CP).sort((a, b) => b.cp - a.cp);
        if (!shallowWinners.length || shallowWinners.length > MAX_SHALLOW_WINNERS) return null;

        const deepBySq = new Map();
        const deepEval = async (cand) => {
          if (!deepBySq.has(cand.sq)) {
            deepBySq.set(cand.sq, await evaluatePlayer(pool, cand.fen, player, { movetime: DEEP_MS }));
          }
          return deepBySq.get(cand.sq);
        };

        let winner = null;
        for (const cand of shallowWinners.slice(0, 3)) {
          const deep = await deepEval(cand);
          if (deep >= WIN_CP) { winner = { ...cand, cp: deep }; break; }
        }
        if (!winner) return null;

        await Promise.all(scans.filter((c) => c.cp >= EXCLUDE_VERIFY_CP).map(deepEval));
        const looseWins = [...deepBySq.entries()]
          .filter(([, deep]) => deep >= EXCLUDE_CP)
          .map(([sq]) => sq)
          .sort();
        const excluded = looseWins.filter((sq) => sq !== winner.sq);
        return { scans, winner, excluded, looseWins };
      };

      // Player-to-move analysis (pick-a-square / hidden-square modes).
      let own = null;
      if (isLegalStart(buildFen(baseMap, player))) {
        own = await scanPlacements(player);
      }

      // Pick-a-square additionally needs two verified-losing decoy squares.
      let losers = [];
      if (own) {
        const ranked = own.scans
          .filter((s) => s.cp <= SHALLOW_LOSS_CP)
          .sort((a, b) => (b.cp - a.cp) || (squareDistance(a.sq, own.winner.sq) - squareDistance(b.sq, own.winner.sq)));
        for (const cand of ranked) {
          if (losers.length >= 2) break;
          const deep = await evaluatePlayer(pool, cand.fen, player, { movetime: DEEP_MS });
          if (deep <= LOSS_CP) losers.push({ ...cand, cp: deep });
        }
        if (losers.length < 2) own = null; // without decoys we drop those modes
      }

      // Opponent-to-move analysis (opponent-first / open-board modes). King
      // puzzles have no legal base FEN, but every placement FEN is legal.
      const baseOppLegal = isLegalStart(buildFen(baseMap, opponent));
      let opp = null;
      if (baseOppLegal || piece.type === 'k') {
        opp = await scanPlacements(opponent);
      }

      if (!own && !opp) continue;

      const lastName = (s) => (s ?? '?').split(',')[0].trim();
      seen.add(key);
      fromThisGame++;
      const puzzle = {
        name: `${lastName(parsed.white)}–${lastName(parsed.black)}, ${(parsed.headers.Date ?? '').slice(0, 4)}`,
        description: `From ${label}, around move ${pos.moveNumber}. Missing piece: a ${PIECE_NAMES[piece.type]}.`,
        fen: buildFen(baseMap, player),
        player,
        place: [piece.type],
        source: {
          white: parsed.white, black: parsed.black, event: parsed.headers.Event,
          year: (parsed.headers.Date ?? '').slice(0, 4), moveNumber: pos.moveNumber,
          removedFrom: origin,
        },
      };
      if (own) {
        puzzle.candidates = [own.winner.sq, ...losers.map((l) => l.sq)].sort();
        puzzle.excluded = own.excluded;
        puzzle.solution = own.winner.sq;
        puzzle.source.evals = { win: own.winner.cp, losses: losers.map((l) => l.cp) };
      }
      if (opp && baseOppLegal) {
        puzzle.p3 = { excluded: opp.excluded, solution: opp.winner.sq, winCp: opp.winner.cp };
      }
      if (opp && opp.looseWins.length <= MAX_P4_SOLUTIONS) {
        puzzle.p4 = { solutions: opp.looseWins, winCp: opp.winner.cp };
      }
      if (!puzzle.candidates && !puzzle.p3 && !puzzle.p4) {
        seen.delete(key);
        fromThisGame--;
        continue; // qualified for nothing after all
      }
      puzzles.push(puzzle);
      console.error(
        `  ✓ puzzle: remove ${piece.type.toUpperCase()} from ${origin} @ move ${pos.moveNumber}` +
        (puzzle.candidates
          ? ` — pick-a-square win ${own.winner.sq} (+${(own.winner.cp / 100).toFixed(1)}), ` +
            `losses ${losers.map((l) => `${l.sq} (${(l.cp / 100).toFixed(1)})`).join(', ')}`
          : '') +
        (puzzle.p3 ? ` — opp-first win ${opp.winner.sq} (+${(opp.winner.cp / 100).toFixed(1)})` : '') +
        (puzzle.p4 ? ` — open-board solutions [${puzzle.p4.solutions.join(' ')}]` : ''),
      );
      break; // at most one puzzle per sampled position, for variety
    }
  }
}
mineLog(`${puzzles.length} positions mined; engine ${JSON.stringify(pool.stats())}`);
await pool.close();

// Expand each mined position into contract puzzles (one per supported mode)
// and ship them as a new immutable batch. Mode tags keep names distinct in
// the puzzle dropdown when one position qualifies for several modes.
const MODE_TAGS = {
  candidates: 'pick a square',
  hidden: 'hidden square',
  'opponent-first': 'opponent moves first',
  open: 'open board',
};
const contractPuzzles = puzzles.flatMap((legacy) =>
  legacyToContract(legacy).map(({ mode, puzzle }) => ({
    ...puzzle,
    name: `${puzzle.name} — ${MODE_TAGS[mode] ?? mode}`,
  })),
);
if (!contractPuzzles.length) {
  console.error('\nNothing qualified — nothing written.');
  process.exit(1);
}
const { path, batchId, count } = writeBatch({
  label: LABEL,
  generator: 'scripts/generate-puzzles.mjs (GM games, one puzzle per qualifying mode)',
  puzzles: contractPuzzles,
  dir: OUT_DIR,
});
console.error(`\nWrote ${count} contract puzzles (from ${puzzles.length} positions) to ${path} (batch ${batchId})`);
console.error('Next: optionally bake lines with  node scripts/generate-lines.mjs --file ' + path);
