// Cost-model audit: measures the ACTUAL per-call cost of every analysis
// function and of engine calls on this machine, so pipeline time estimates
// can be checked against reality instead of the numbers in the doc comments.
//
// Usage: node scripts/bench.mjs [--pgn data/lichess-games.pgn] [--sample 400]
//        [--engine]   (also benchmark engine calls; ~30s extra)

import { existsSync } from 'node:fs';
import { Chess } from 'chess.js';
import { readCorpus, samplePositions } from './lib/corpus.mjs';
import * as features from './lib/features.mjs';
import { hotSectors, legalPlacements, enumerateCombos } from './lib/detectors.mjs';
import { fenToMap } from '../src/fen.js';
import { EnginePool } from './lib/engine.mjs';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const PGN = opt('pgn', existsSync('data/lichess-games-2.pgn') ? 'data/lichess-games-2.pgn' : 'data/lichess-games.pgn');
const SAMPLE = Number(opt('sample', 400));
const WITH_ENGINE = process.argv.includes('--engine');

// ---- Gather a sample of real middlegame positions ----
const games = readCorpus(PGN);
const positions = [];
outer: for (const parsed of games) {
  for (const s of samplePositions(parsed)) {
    positions.push(s.fen);
    if (positions.length >= SAMPLE) break outer;
  }
}
const boards = positions.map((fen) => new Chess(fen));
console.log(`Benchmarking on ${boards.length} positions from ${PGN}\n`);

const table = [];
function bench(name, fn, per = boards.length) {
  const t0 = performance.now();
  for (const b of boards) fn(b);
  const ms = performance.now() - t0;
  table.push({ name, 'µs/call': Math.round((ms / per) * 1000), 'ms total': Math.round(ms) });
}

// ---- Static features ----
bench('features.material', features.material);
bench('features.attacks', features.attacks);
bench('features.pins', features.pins);
bench('features.kingSafety', features.kingSafety);
bench('features.passedPawns', features.passedPawns);
bench('features.mobility', features.mobility);
bench('features.allFeatures', features.allFeatures);

// ---- Detectors ----
bench('detectors.hotSectors', (b) => hotSectors(fenToMap(b.fen()), b.fen(), b.turn()));
bench('detectors.legalPlacements(64sq)', (b) => {
  const map = fenToMap(b.fen());
  const sq = Object.keys(map).find((s) => map[s].type === 'n' && map[s].color === b.turn());
  if (!sq) return;
  const piece = map[sq];
  const base = { ...map };
  delete base[sq];
  legalPlacements(base, piece, b.turn());
});
bench('detectors.enumerateCombos(2 of 7)', () => enumerateCombos(['q', 'n'], ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7']));

console.table(table);

// ---- Engine calls (optional; wall-clock, not per-core) ----
if (WITH_ENGINE) {
  const pool = await new EnginePool().init();
  const fens = positions.slice(0, 12);
  for (const movetime of [80, 300, 700]) {
    const t0 = performance.now();
    await Promise.all(fens.map((fen) => pool.evaluate(fen, { movetime })));
    const ms = performance.now() - t0;
    console.log(`engine.evaluate movetime=${movetime}ms ×${fens.length} on pool(${pool.size}): `
      + `${Math.round(ms)}ms wall → ${Math.round(ms / fens.length)}ms/call amortized `
      + `(serial cost would be ${movetime * fens.length}ms)`);
  }
  console.log('pool stats:', pool.stats());
  await pool.close();
}

console.log(`\nPipeline math: stage cost ≈ positions × (Σ static µs) + engine calls × movetime ÷ pool size.`);
