// Sector-build puzzle generator: 3×3-zone multi-piece placement puzzles.
// A thin composition over the generation libraries — selection via static
// features, candidate regions via detectors.hotSectors, verification via
// qualify.* on one shared EnginePool. Single process, all in memory.
//
// The idea: find positions where the player is winning but the OPPONENT is
// to move, locate a tactically hot 3×3 sector, remove the player's pieces
// from it, and keep the position only when few ways of putting them back
// inside the sector keep it winning.
//
// Usage: node scripts/generate-sectors.mjs --label "My batch label"
//   [--pgn data/lichess-games.pgn] [--features <cache.jsonl>]
//   [--top 300] [--offset 0] [--pool 3] [--out-dir src/puzzles]
//
// COST (pool of 3): candidates failing the origin gate cost 1 shallow eval
// (~80ms); a qualifying candidate costs |combos| × 80ms + gray-zone × 700ms
// ≈ 30–60s. Expect minutes per emitted puzzle; the pool stats print at exit.

import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { featureRows, stageTimer } from './lib/pipeline.mjs';
import { readCorpus } from './lib/corpus.mjs';
import { hotSectors, enumerateCombos } from './lib/detectors.mjs';
import { evaluatePlayer, scanPlacements } from './lib/qualify.mjs';
import { readBatches, writeBatch } from './lib/batches.mjs';
import { fenToMap, buildFen } from '../src/fen.js';
import { isLegalStart } from '../src/puzzle-contract.js';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const ORIGIN_WIN_CP = 300; // the source position must already be winning
const ORIGIN_MAX_CP = 1200; // …but not so crushing that anything wins
const MAX_MATERIAL_EDGE = 1; // dynamic wins only: no real material edge
const WIN_CP = 300; // deep-verified "this combo wins"
const LOOSE_WIN_CP = 150; // anything at/above this counts as a solution
const DEEP_VERIFY_CP = 50; // shallow gray zone that gets a deep look
const MAX_SOLUTIONS = 3; // "one or very few" winning combos
const MAX_SHALLOW_WINNERS = 6; // more = placement isn't sharp, skip sector
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };

// ---- Options ----
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PGN_FILE = opt('pgn', 'data/lichess-games.pgn');
const FEATURES_CACHE = opt('features', null);
const TOP_N = Number(opt('top', 300));
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

// Positions already used by ANY existing batch are off-limits.
const covered = new Set();
for (const { puzzles } of readBatches()) {
  for (const p of puzzles) covered.add(`${p.meta?.source?.site}|${p.meta?.source?.moveNumber}|${p.player}`);
}

// Rank by static sharpness; keep only positions where the player (the side
// NOT to move) has no real material edge, so the win is dynamic and the
// placement of the removed pieces actually matters. Max 2 per game.
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
selectLog(`${jobs.length} sharp positions (offset ${OFFSET}, features ${fromCache ? 'from cache' : 'computed'})`);

// ---- Engine qualification ----
const pool = await new EnginePool(POOL_SIZE).init();

async function qualify({ row, meta, player }) {
  const opponent = player === 'w' ? 'b' : 'w';
  const originCp = await evaluatePlayer(pool, row.fen, player, { movetime: SHALLOW_MS });
  if (originCp < ORIGIN_WIN_CP || originCp > ORIGIN_MAX_CP) {
    return { log: `skip g${row.game} ply${row.ply}: player eval ${originCp}cp (want ${ORIGIN_WIN_CP}..${ORIGIN_MAX_CP})` };
  }

  const map = fenToMap(row.fen);
  const sectors = hotSectors(map, row.fen, player);
  if (!sectors.length) return { log: `skip g${row.game} ply${row.ply}: no hot 3×3 sector` };

  const reasons = [];
  for (const sector of sectors) {
    const baseMap = { ...map };
    const removedTypes = [];
    for (const sq of sector.mine) {
      removedTypes.push(baseMap[sq].type);
      delete baseMap[sq];
    }
    const empties = sector.squares.filter((sq) => !baseMap[sq]);
    if (empties.length < removedTypes.length + 2) {
      reasons.push(`${sector.anchor}: sector too crowded`);
      continue;
    }
    const combos = enumerateCombos(removedTypes, empties);
    if (combos.size > 400) {
      reasons.push(`${sector.anchor}: ${combos.size}+ combos`);
      continue;
    }

    const candidates = [];
    for (const [sig, placements] of combos) {
      const posMap = { ...baseMap };
      for (const p of placements) posMap[p.square] = { type: p.type, color: player };
      const fen = buildFen(posMap, opponent);
      if (!isLegalStart(fen)) continue;
      candidates.push({ sig, fen });
    }
    const scans = await scanPlacements(pool, candidates, player, { movetime: SHALLOW_MS });
    const shallowWinners = scans.filter((s) => s.cp >= WIN_CP);
    if (!shallowWinners.length) { reasons.push(`${sector.anchor}: no winning combo`); continue; }
    if (shallowWinners.length > MAX_SHALLOW_WINNERS) {
      reasons.push(`${sector.anchor}: ${shallowWinners.length} shallow-winning combos`);
      continue;
    }

    const grayZone = scans.filter((s) => s.cp >= DEEP_VERIFY_CP);
    const deep = await scanPlacements(pool, grayZone, player, { movetime: DEEP_MS });
    const looseWins = deep.filter((s) => s.cp >= LOOSE_WIN_CP).map((s) => s.sig).sort();
    const winners = deep.filter((s) => s.cp >= WIN_CP);
    if (!winners.length) { reasons.push(`${sector.anchor}: no deep-verified winner`); continue; }
    if (looseWins.length > MAX_SOLUTIONS) {
      reasons.push(`${sector.anchor}: ${looseWins.length} winning combos`);
      continue;
    }

    const winCp = Math.max(...winners.map((s) => s.cp));
    const pieceList = removedTypes.map((t) => PIECE_NAMES[t]).join(' + ');
    return {
      puzzle: {
        name: `${meta.white}–${meta.black} (Lichess)`,
        description:
          `From a Lichess game (${meta.site}), around move ${row.moveNo}. ` +
          `Rebuild the attack: place your ${pieceList} inside the highlighted 3×3 zone. ` +
          `The opponent moves first.`,
        fen: buildFen(baseMap, player),
        player,
        place: removedTypes,
        firstMove: 'opponent',
        placement: { allowed: empties.sort() },
        solutions: looseWins,
        meta: {
          foundBy: ['sector-activity'],
          sector: sector.anchor,
          winCp,
          source: {
            white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
            moveNumber: row.moveNo, ply: row.ply,
            removedFrom: sector.mine.map((sq, i) => `${removedTypes[i]}@${sq}`),
          },
        },
      },
      log: `✓ g${row.game} ply${row.ply} sector ${sector.anchor}: remove [${removedTypes.join(' ').toUpperCase()}] — ` +
        `${looseWins.length} winning combo(s), best +${(winCp / 100).toFixed(1)}`,
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
  generator: `scripts/generate-sectors.mjs (3×3 hot sectors, top ${TOP_N} sharp positions, offset ${OFFSET})`,
  puzzles: fresh,
  dir: OUT_DIR,
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
