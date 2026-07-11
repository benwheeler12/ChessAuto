// Exact-spots puzzle generator: a coordinated cluster of the player's
// pieces leaves the board, their ORIGINAL squares become the only allowed
// spots, and the player must put each piece back on the right square —
// exactly as many pieces in the tray as spots on the board, exactly one
// arrangement wins. A thin composition over the generation libraries:
// single process, one shared EnginePool, all in memory.
//
// Selection favors sharp positions where the player is EVEN OR BEHIND in
// material but winning by engine eval — the win lives in the coordination,
// so scrambling the pieces ruins it. Clusters come from
// detectors.defenseClusters (mutually defending / adjacent pieces).
//
// Usage: node scripts/generate-spots.mjs --label "My batch label"
//   [--pgn data/lichess-games.pgn] [--features <cache.jsonl>]
//   [--top 400] [--offset 0] [--pool 3] [--out-dir src/puzzles]
//
// COST (pool of 3): failed origin gates cost 1 shallow eval (~80ms); a
// candidate that reaches assignment testing costs ≤6 deep evals (700ms)
// ≈ 2s — an order of magnitude cheaper per candidate than sector builds.

import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { featureRows, stageTimer } from './lib/pipeline.mjs';
import { readCorpus } from './lib/corpus.mjs';
import { defenseClusters, enumerateCombos } from './lib/detectors.mjs';
import { evaluatePlayer, scanPlacements } from './lib/qualify.mjs';
import { readBatches, writeBatch } from './lib/batches.mjs';
import { fenToMap, buildFen } from '../src/fen.js';
import { isLegalStart } from '../src/puzzle-contract.js';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const ORIGIN_WIN_CP = 300; // the source position must already be winning…
const ORIGIN_MAX_CP = 1200; // …but not so crushing that anything wins
const MAX_MATERIAL_EDGE = 0; // player even or BEHIND: the win is coordination
const WIN_CP = 300; // the unique correct arrangement must clearly win
const MAX_OTHER_CP = 50; // every wrong arrangement must be at best equal
const CLUSTER_SIZE = 3; // pieces per puzzle (6 arrangements when distinct)
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };

// ---- Options ----
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PGN_FILE = opt('pgn', 'data/lichess-games.pgn');
const FEATURES_CACHE = opt('features', null);
const TOP_N = Number(opt('top', 400));
const OFFSET = Number(opt('offset', 0));
const POOL_SIZE = Number(opt('pool', 3));
const OUT_DIR = opt('out-dir', 'src/puzzles');
const LABEL = opt('label', null);
if (!LABEL) {
  console.error('A --label for the new batch is required (shown in the collection dropdown).');
  process.exit(1);
}

// ---- Candidate selection (static, engine-free) ----
const selectLog = stageTimer('select');
const games = readCorpus(PGN_FILE);
const { rows, fromCache } = featureRows(PGN_FILE, { cachePath: FEATURES_CACHE });

const covered = new Set();
for (const { puzzles } of readBatches()) {
  for (const p of puzzles) covered.add(`${p.meta?.source?.site}|${p.meta?.source?.moveNumber}|${p.player}`);
}

// Sharpest positions first; player (side NOT to move) even or behind in
// material, so an engine-verified win must come from piece coordination.
const sharpness = (r) => r.tension * 2 + r.contacts + r.hangingTotal + r.pinsTotal;
const perGame = new Map();
const jobs = [];
let skipped = 0;
for (const row of [...rows].sort((a, b) => sharpness(b) - sharpness(a))) {
  if (jobs.length >= TOP_N) break;
  const playerIsWhite = row.turn === 'b';
  const edge = playerIsWhite ? row.materialW - row.materialB : row.materialB - row.materialW;
  if (edge > MAX_MATERIAL_EDGE) continue;
  const n = perGame.get(row.game) ?? 0;
  if (n >= 2) continue;
  const meta = games[row.game];
  const player = playerIsWhite ? 'w' : 'b';
  if (covered.has(`${meta.site}|${row.moveNo}|${player}`)) continue;
  perGame.set(row.game, n + 1);
  if (skipped < OFFSET) { skipped++; continue; }
  jobs.push({ row, meta, player });
}
selectLog(`${jobs.length} sharp even-or-behind positions (offset ${OFFSET}, features ${fromCache ? 'from cache' : 'computed'})`);

// ---- Engine qualification ----
const pool = await new EnginePool(POOL_SIZE).init();

async function qualify({ row, meta, player }) {
  const opponent = player === 'w' ? 'b' : 'w';
  const originCp = await evaluatePlayer(pool, row.fen, player, { movetime: SHALLOW_MS });
  if (originCp < ORIGIN_WIN_CP || originCp > ORIGIN_MAX_CP) {
    return { log: `skip g${row.game} ply${row.ply}: player eval ${originCp}cp (want ${ORIGIN_WIN_CP}..${ORIGIN_MAX_CP})` };
  }

  const map = fenToMap(row.fen);
  const clusters = defenseClusters(map, row.fen, player, { size: CLUSTER_SIZE });
  if (!clusters.length) return { log: `skip g${row.game} ply${row.ply}: no ${CLUSTER_SIZE}-piece cluster` };

  const reasons = [];
  for (const cluster of clusters) {
    const baseMap = { ...map };
    for (const sq of cluster.squares) delete baseMap[sq];
    const spots = [...cluster.squares].sort();

    // Every assignment of the cluster's pieces onto its own spots.
    const assignments = [];
    for (const [sig, placements] of enumerateCombos(cluster.types, spots)) {
      const posMap = { ...baseMap };
      for (const p of placements) posMap[p.square] = { type: p.type, color: player };
      const fen = buildFen(posMap, opponent);
      if (!isLegalStart(fen)) continue;
      assignments.push({ sig, fen });
    }
    if (assignments.length < 3) {
      reasons.push(`${spots.join(',')}: only ${assignments.length} legal arrangements`);
      continue;
    }

    // So few arrangements that every one gets a deep verdict directly.
    const scans = await scanPlacements(pool, assignments, player, { movetime: DEEP_MS });
    const winners = scans.filter((s) => s.cp >= WIN_CP);
    if (winners.length !== 1) {
      reasons.push(`${spots.join(',')}: ${winners.length} winning arrangements`);
      continue;
    }
    const nearMisses = scans.filter((s) => s.cp < WIN_CP && s.cp > MAX_OTHER_CP);
    if (nearMisses.length) {
      reasons.push(`${spots.join(',')}: ${nearMisses.length} arrangements too close to winning`);
      continue;
    }

    const winner = winners[0];
    const pieceList = cluster.types.map((t) => PIECE_NAMES[t]).join(' + ');
    return {
      puzzle: {
        name: `${meta.white}–${meta.black} (Lichess)`,
        description:
          `From a Lichess game (${meta.site}), around move ${row.moveNo}. ` +
          `Your ${pieceList} have left their posts — put each piece back on the right spot. ` +
          `Exactly one arrangement wins, and the opponent moves first.`,
        fen: buildFen(baseMap, player),
        player,
        place: cluster.types,
        firstMove: 'opponent',
        placement: { allowed: spots },
        solutions: [winner.sig],
        meta: {
          foundBy: ['defense-cluster'],
          winCp: winner.cp,
          arrangements: scans.length,
          source: {
            white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
            moveNumber: row.moveNo, ply: row.ply,
            removedFrom: cluster.squares.map((sq) => `${map[sq].type}@${sq}`),
          },
        },
      },
      log: `✓ g${row.game} ply${row.ply} spots [${spots.join(' ')}] pieces [${cluster.types.join(' ').toUpperCase()}] — ` +
        `unique winner ${winner.sig} (+${(winner.cp / 100).toFixed(1)}) of ${scans.length} arrangements`,
    };
  }
  return { log: `✗ g${row.game} ply${row.ply}: ${reasons.join('; ')}` };
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
  generator: `scripts/generate-spots.mjs (defense clusters, unique arrangement, top ${TOP_N} offset ${OFFSET})`,
  puzzles: fresh,
  dir: OUT_DIR,
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
