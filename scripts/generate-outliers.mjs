// Outlier-discovery puzzle generator: feature-outlier positions become
// open-board contract puzzles (opponent moves first, at most two placements
// win). A thin composition over the generation libraries — single process,
// one shared EnginePool, all in memory.
//
// Selection: top N positions per static heuristic (max 2 per game, deduped
// across heuristics and against every existing batch).
//
// Usage: node scripts/generate-outliers.mjs --label "My batch label"
//   [--pgn data/lichess-games.pgn] [--features <cache.jsonl>]
//   [--top 3] [--pool 3] [--out-dir src/puzzles]
//
// COST (pool of 3): each candidate costs 1 origin eval + per removable
// piece a ~60-square shallow scan (80ms each) + a handful of deep evals
// (700ms) ≈ 20–60s per position that clears the early gates.

import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { featureRows, stageTimer } from './lib/pipeline.mjs';
import { readCorpus } from './lib/corpus.mjs';
import { removablePieces, legalPlacements } from './lib/detectors.mjs';
import { evaluatePlayer, scanPlacements } from './lib/qualify.mjs';
import { readBatches, writeBatch } from './lib/batches.mjs';
import { RANKABLE_FEATURES } from './lib/features.mjs';
import { fenToMap, buildFen } from '../src/fen.js';
import { isLegalStart } from '../src/puzzle-contract.js';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const WIN_CP = 300;
const SHALLOW_WIN_CP = 350;
const DEEP_VERIFY_CP = 50;
const LOOSE_WIN_CP = 150;
const MAX_SHALLOW_WINNERS = 6;
const MAX_SOLUTIONS = 2;
const ORIGIN_EVAL_LIMIT = 700; // skip positions that were already blowouts
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };

// ---- Options ----
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PGN_FILE = opt('pgn', 'data/lichess-games.pgn');
const FEATURES_CACHE = opt('features', null);
const TOP_N = Number(opt('top', 3));
const POOL_SIZE = Number(opt('pool', 3));
const OUT_DIR = opt('out-dir', 'src/puzzles');
const LABEL = opt('label', null);
if (!LABEL) {
  console.error('A --label for the new batch is required (shown in the collection dropdown).');
  process.exit(1);
}

// ---- Candidate selection: top-N outliers per heuristic ----
const selectLog = stageTimer('select');
const games = readCorpus(PGN_FILE);
const { rows, fromCache } = featureRows(PGN_FILE, { cachePath: FEATURES_CACHE });

const covered = new Set();
for (const { puzzles } of readBatches()) {
  for (const p of puzzles) covered.add(`${p.meta?.source?.site}|${p.meta?.source?.moveNumber}|${p.player}`);
}

const selected = new Map();
for (const feature of RANKABLE_FEATURES) {
  const usable = rows.filter((r) => r[feature] != null).sort((a, b) => b[feature] - a[feature]);
  const perGame = new Map();
  let taken = 0;
  for (const row of usable) {
    if (taken >= TOP_N) break;
    const n = perGame.get(row.game) ?? 0;
    if (n >= 2) continue;
    perGame.set(row.game, n + 1);
    taken++;
    const key = `${row.game}|${row.ply}`;
    const entry = selected.get(key) ?? { row, foundBy: [] };
    entry.foundBy.push(feature);
    selected.set(key, entry);
  }
}

const jobs = [];
for (const { row, foundBy } of selected.values()) {
  const meta = games[row.game];
  const player = row.fen.split(' ')[1]; // outliers keep the side to move as player
  if (covered.has(`${meta.site}|${row.moveNo}|${player}`)) continue;
  jobs.push({ row, foundBy, meta, variant: jobs.length });
}
selectLog(`${selected.size} outliers → ${jobs.length} new positions (features ${fromCache ? 'from cache' : 'computed'})`);

// ---- Engine qualification ----
const pool = await new EnginePool(POOL_SIZE).init();

async function qualify({ row, foundBy, meta, variant }) {
  const player = row.fen.split(' ')[1];
  const opponent = player === 'w' ? 'b' : 'w';
  const map = fenToMap(row.fen);

  const originCp = await pool.evaluate(row.fen, { movetime: SHALLOW_MS });
  if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) {
    return { log: `skip g${row.game} ply${row.ply}: origin ${originCp}cp (one-sided)` };
  }

  const reasons = [];
  for (const [origin, piece] of removablePieces(map, player, variant)) {
    const baseMap = { ...map };
    delete baseMap[origin];
    if (!isLegalStart(buildFen(baseMap, opponent)) && piece.type !== 'k') {
      reasons.push(`${piece.type}@${origin}: illegal base`);
      continue;
    }
    const placements = legalPlacements(baseMap, piece, opponent);
    const scans = await scanPlacements(pool, placements, player, { movetime: SHALLOW_MS });
    const shallowWinners = scans.filter((s) => s.cp >= SHALLOW_WIN_CP).sort((a, b) => b.cp - a.cp);
    if (!shallowWinners.length) { reasons.push(`${piece.type}@${origin}: no winning square`); continue; }
    if (shallowWinners.length > MAX_SHALLOW_WINNERS) {
      reasons.push(`${piece.type}@${origin}: ${shallowWinners.length} shallow winners`);
      continue;
    }

    const deepBySq = new Map();
    const deepEval = async (cand) => {
      if (!deepBySq.has(cand.square)) {
        deepBySq.set(cand.square, await evaluatePlayer(pool, cand.fen, player, { movetime: DEEP_MS }));
      }
      return deepBySq.get(cand.square);
    };
    let winner = null;
    for (const cand of shallowWinners.slice(0, 3)) {
      const deep = await deepEval(cand);
      if (deep >= WIN_CP) { winner = { ...cand, cp: deep }; break; }
    }
    if (!winner) { reasons.push(`${piece.type}@${origin}: no deep-verified winner`); continue; }
    await Promise.all(scans.filter((c) => c.cp >= DEEP_VERIFY_CP).map(deepEval));
    const looseWins = [...deepBySq.entries()].filter(([, d]) => d >= LOOSE_WIN_CP).map(([sq]) => sq).sort();
    if (looseWins.length > MAX_SOLUTIONS) {
      reasons.push(`${piece.type}@${origin}: ${looseWins.length} winning squares`);
      continue;
    }

    return {
      puzzle: {
        name: `${meta.white}–${meta.black} (Lichess)`,
        description:
          `From a Lichess game (${meta.site}), around move ${row.moveNo}. ` +
          `Missing piece: a ${PIECE_NAMES[piece.type]}. Discovered by: ${foundBy.join(', ')}.`,
        fen: buildFen(baseMap, player),
        player,
        place: [piece.type],
        firstMove: 'opponent',
        solutions: looseWins.map((sq) => `${piece.type}@${sq}`),
        meta: {
          foundBy,
          winCp: winner.cp,
          source: {
            white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
            moveNumber: row.moveNo, ply: row.ply, removedFrom: origin,
          },
        },
      },
      log: `✓ g${row.game} ply${row.ply} remove ${piece.type.toUpperCase()} from ${origin} — ` +
        `solutions [${looseWins.join(' ')}] (+${(winner.cp / 100).toFixed(1)}) — via ${foundBy.join(',')}`,
    };
  }
  return { log: `✗ g${row.game} ply${row.ply} (${foundBy.join(',')}): ${reasons.join('; ') || 'no removable pieces'}` };
}

const qualifyLog = stageTimer('qualify');
let done = 0;
const results = await mapConcurrent(jobs, POOL_SIZE, async (job) => {
  const result = await qualify(job);
  console.error(`  [${++done}/${jobs.length}] ${result.log}`);
  return result;
});
qualifyLog(`${results.filter((r) => r.puzzle).length} qualified; engine ${JSON.stringify(pool.stats())}`);
await pool.close();

const fresh = results.filter((r) => r.puzzle).map((r) => r.puzzle);
if (!fresh.length) {
  console.error('\nNo positions qualified — nothing written.');
  process.exit(1);
}
const { path: outFile, batchId, count } = writeBatch({
  label: LABEL,
  generator: `scripts/generate-outliers.mjs (feature outliers, top ${TOP_N} × ${RANKABLE_FEATURES.length} heuristics)`,
  puzzles: fresh,
  dir: OUT_DIR,
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
console.error('Next: optionally bake lines with  node scripts/generate-lines.mjs --file ' + outFile);
