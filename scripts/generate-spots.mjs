// Exact-spots puzzle generator: a group of the player's pieces leaves the
// board, their ORIGINAL squares become the only allowed spots, and the
// player must put each piece back on the right square — exactly as many
// pieces in the tray as spots on the board, exactly one arrangement wins.
// A thin composition over the generation libraries: single process, one
// shared EnginePool, all in memory.
//
// Selection favors sharp positions where the player is EVEN OR BEHIND in
// material but winning by engine eval — the win lives in the coordination,
// so scrambling the pieces ruins it. Groups come from
// detectors.activeClusters: the removed pieces are the ones doing real
// work (attacking, defending contested pieces, covering king zones), so
// the solver has to read the position's threats to restore them.
//
// Usage: node scripts/generate-spots.mjs --label "My batch label"
//   [--pgn data/lichess-games.pgn] [--features <cache.jsonl>]
//   [--pieces 3] [--scatter] [--top 400] [--offset 0] [--pool 3]
//   [--out-dir src/puzzles]
//
// --pieces N     remove N pieces / N spots (default 3; 4 gives up to 24
//                arrangements instead of 6 — ~4× the deep-eval spend; 5
//                gives up to 120, handled by a shallow prescreen that
//                deep-verifies only arrangements that aren't clearly lost)
// --scatter      drop the connectivity requirement: spots may sit on
//                disparate parts of the board (distant groups rank higher)
// --non-obvious  reject puzzles whose winning arrangement is also the most
//                plausible-looking one (lib/plausibility.mjs pattern cues)
//
// COST (pool of 3): failed origin gates cost 1 shallow eval (~80ms); a
// candidate that reaches assignment testing costs ≤6 deep evals (700ms)
// ≈ 2s at --pieces 3, ≤24 ≈ 8s at --pieces 4, and at --pieces 5 up to
// 120 shallow + ≤30 deep ≈ 10s. The plausibility gate is engine-free.

import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { featureRows, stageTimer } from './lib/pipeline.mjs';
import { readCorpus } from './lib/corpus.mjs';
import { activeClusters, enumerateCombos } from './lib/detectors.mjs';
import { arrangementPlausibility, plausibilityRank } from './lib/plausibility.mjs';
import { evaluatePlayer, scanPlacements } from './lib/qualify.mjs';
import { readBatches, writeBatch } from './lib/batches.mjs';
import { fenToMap, buildFen } from '../src/fen.js';
import { isLegalStart } from '../src/puzzle-contract.js';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const ORIGIN_WIN_CP = 300; // the source position must already be winning…
const MAX_MATERIAL_EDGE = 0; // player even or BEHIND: the win is coordination
const WIN_CP = 300; // the unique correct arrangement must clearly win
const MAX_OTHER_CP = 50; // every wrong arrangement must be at best equal
const MAX_ARRANGEMENTS = 130; // hard cap (5 distinct pieces = 120 permutations)
const PRESCREEN_CP = -100; // shallow score below which an arrangement is written off
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
const CLUSTER_SIZE = Number(opt('pieces', 3));
const SCATTER = process.argv.includes('--scatter');
// Reject puzzles whose winning arrangement is also the most plausible-
// looking one (pattern-recognition cues: supported pawn chains, outpost
// knights, batteries… — see lib/plausibility.mjs). Solving those takes
// instinct, not calculation.
const NON_OBVIOUS = process.argv.includes('--non-obvious');
// …but not so crushing that anything wins. More pieces to replace means
// more arrangements that keep a fat margin winning, so bigger groups need
// origins that are only just winning to keep the solution unique.
const ORIGIN_MAX_CP = Number(opt('origin-max', CLUSTER_SIZE >= 4 ? 600 : 1200));
// With 5 spots (up to 120 arrangements) a UNIQUE winner is nearly
// unsatisfiable — positions winning by 300cp can usually be rebuilt a few
// ways. Allowing a small solution set keeps the category viable: finding
// one of ≤3 winners among 120 arrangements is still hard.
const MAX_WINNERS = Number(opt('max-winners', 1));
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
  const clusters = activeClusters(map, row.fen, player, { size: CLUSTER_SIZE, scatter: SCATTER });
  if (!clusters.length) return { log: `skip g${row.game} ply${row.ply}: no ${CLUSTER_SIZE}-piece active group` };

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
      assignments.push({ sig, fen, placements });
    }
    if (assignments.length < 3) {
      reasons.push(`${spots.join(',')}: only ${assignments.length} legal arrangements`);
      continue;
    }
    if (assignments.length > MAX_ARRANGEMENTS) {
      reasons.push(`${spots.join(',')}: ${assignments.length} arrangements — too costly to verify`);
      continue;
    }

    // ≤24 arrangements get a deep verdict directly. Above that (5-piece
    // groups run to 120), a shallow prescreen prunes clearly-losing
    // arrangements first: anything under PRESCREEN_CP at 80ms is assumed
    // to stay under MAX_OTHER_CP at depth (300cp of margin for shallow
    // noise on the winner side; arrangements that scramble coordination
    // are usually losing by far more than 100cp).
    let scans;
    if (assignments.length <= 24) {
      scans = await scanPlacements(pool, assignments, player, { movetime: DEEP_MS });
    } else {
      const shallow = await scanPlacements(pool, assignments, player, { movetime: SHALLOW_MS });
      const survivors = shallow.filter((s) => s.cp >= PRESCREEN_CP);
      if (!survivors.length) {
        reasons.push(`${spots.join(',')}: prescreen left nothing near winning`);
        continue;
      }
      if (survivors.length > 30) {
        reasons.push(`${spots.join(',')}: ${survivors.length} arrangements past prescreen — position too forgiving`);
        continue;
      }
      scans = await scanPlacements(pool, survivors.map(({ cp, ...a }) => a), player, { movetime: DEEP_MS });
    }
    const winners = scans.filter((s) => s.cp >= WIN_CP);
    if (winners.length < 1 || winners.length > MAX_WINNERS) {
      reasons.push(`${spots.join(',')}: ${winners.length} winning arrangements (want 1..${MAX_WINNERS})`);
      continue;
    }
    const nearMisses = scans.filter((s) => s.cp < WIN_CP && s.cp > MAX_OTHER_CP);
    if (nearMisses.length) {
      reasons.push(`${spots.join(',')}: ${nearMisses.length} arrangements too close to winning`);
      continue;
    }

    // Obviousness gate: score EVERY legal arrangement by pattern-
    // recognition plausibility; if any winning arrangement is (or ties
    // for) the most plausible-looking, instinct solves the puzzle —
    // reject it.
    let hidden = null;
    if (NON_OBVIOUS) {
      const scored = assignments.map((a) => ({
        sig: a.sig,
        plausibility: arrangementPlausibility(a.fen, a.placements, player),
      }));
      const ranks = winners.map((w) => plausibilityRank(scored, w.sig));
      const exposed = ranks.find((r) => !r.hidden);
      if (exposed) {
        reasons.push(`${spots.join(',')}: a winner looks as plausible as anything (score ${exposed.score} vs top ${exposed.top})`);
        continue;
      }
      const worst = ranks.reduce((a, b) => (b.score > a.score ? b : a));
      hidden = { plausibilityRank: worst.rank, plausibility: worst.score, topPlausibility: worst.top };
    }

    const winner = winners.reduce((a, b) => (b.cp > a.cp ? b : a));
    const pieceList = cluster.types.map((t) => PIECE_NAMES[t]).join(' + ');
    return {
      puzzle: {
        name: `${meta.white}–${meta.black} (Lichess)`,
        description:
          `From a Lichess game (${meta.site}), around move ${row.moveNo}. ` +
          `Your most active pieces — ${pieceList} — have left their posts` +
          `${SCATTER ? ' across the board' : ''}. Put each piece back on the right spot. ` +
          `${winners.length === 1
            ? 'Exactly one arrangement wins'
            : `Only ${winners.length} of the ${assignments.length} arrangements win`}, ` +
          'and the opponent moves first.',
        fen: buildFen(baseMap, player),
        player,
        place: cluster.types,
        firstMove: 'opponent',
        placement: { allowed: spots },
        solutions: winners.map((w) => w.sig).sort(),
        meta: {
          foundBy: [SCATTER ? 'active-scatter' : 'active-cluster', ...(NON_OBVIOUS ? ['non-obvious'] : [])],
          ...(hidden ?? {}),
          activity: cluster.activity,
          winCp: winner.cp,
          arrangements: assignments.length,
          source: {
            white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
            moveNumber: row.moveNo, ply: row.ply,
            removedFrom: cluster.squares.map((sq) => `${map[sq].type}@${sq}`),
          },
        },
      },
      log: `✓ g${row.game} ply${row.ply} spots [${spots.join(' ')}] pieces [${cluster.types.join(' ').toUpperCase()}] — ` +
        `${winners.length === 1 ? `unique winner ${winner.sig}` : `${winners.length} winners (best ${winner.sig})`} ` +
        `(+${(winner.cp / 100).toFixed(1)}) of ${assignments.length} arrangements`,
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

// One puzzle per source game keeps a batch varied.
const seenGames = new Set();
const fresh = [];
for (const r of results) {
  if (!r.puzzle) continue;
  const site = r.puzzle.meta.source.site;
  if (seenGames.has(site)) continue;
  seenGames.add(site);
  fresh.push(r.puzzle);
}
if (!fresh.length) {
  console.error('\nNo positions qualified — nothing written.');
  process.exit(1);
}
const { path: outFile, batchId, count } = writeBatch({
  label: LABEL,
  generator: `scripts/generate-spots.mjs (active pieces${SCATTER ? ', scattered' : ''}` +
    `${NON_OBVIOUS ? ', non-obvious' : ''}, ${CLUSTER_SIZE} spots, unique arrangement, ` +
    `top ${TOP_N} offset ${OFFSET})`,
  puzzles: fresh,
  dir: OUT_DIR,
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
