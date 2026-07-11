// Precomputes full engine-vs-engine playout lines for puzzles, so the game
// needs no Stockfish at runtime. Operates on contract batch files: for
// every reachable placement of a puzzle that carries verdicts (solutions),
// a line is played to a terminal position and must agree with the verdict.
// Mismatches retry at higher think times (qualify.playLine's ladder);
// persistent mismatches are self-healed (square blocked / solution removed
// / puzzle dropped).
//
// Multi-piece puzzles and puzzles without solutions are skipped (no line
// space or nothing to verify).
//
// Usage:  node scripts/generate-lines.mjs --file src/puzzles/batch-XXX.js
//         [--pool 3] [--only <id>,<id>]
//
// COST (pool of 3): one line ≈ game length (40–200 plies) × movetime
// (60ms first attempt), so ~5–15s per placement; a 60-placement puzzle
// bakes in ~3–8 minutes. Pool stats print at exit.

import { writeFileSync } from 'node:fs';
import { EnginePool, mapConcurrent } from './lib/engine.mjs';
import { stageTimer } from './lib/pipeline.mjs';
import { playLine } from './lib/qualify.mjs';
import { parseBatchFile } from './lib/batches.mjs';
import { readFileSync } from 'node:fs';
import {
  signature, parseSignature, startFen, placementError, placeableSquares,
} from '../src/puzzle-contract.js';
import { fenToMap } from '../src/fen.js';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const FILE = opt('file', null);
if (!FILE) {
  console.error('Usage: node scripts/generate-lines.mjs --file src/puzzles/batch-XXX.js [--pool 3] [--only id,id]');
  process.exit(1);
}
const POOL_SIZE = Number(opt('pool', 3));
// --only p5-4,p5-5 bakes just those puzzles (for incremental, resumable runs)
const ONLY = opt('only', null)?.split(',') ?? null;

const puzzles = parseBatchFile(FILE);
const jobs = [];
for (const puzzle of puzzles) {
  if (ONLY && !ONLY.includes(puzzle.id)) continue;
  if (puzzle.place.length > 1) {
    console.error(`  (skipping ${puzzle.id}: multi-piece baking not supported yet)`);
    continue;
  }
  if (!puzzle.solutions) {
    console.error(`  (skipping ${puzzle.id}: no verdicts to verify)`);
    continue;
  }
  const type = puzzle.place[0];
  for (const square of placeableSquares(puzzle, type)) {
    const placements = [{ type, square }];
    const sig = signature(placements);
    jobs.push({
      key: `${puzzle.id}|${sig}`,
      fen: startFen(puzzle, placements),
      player: puzzle.player,
      expect: puzzle.solutions.includes(sig) ? 'win' : 'notwin',
    });
  }
}
console.error(`${jobs.length} lines to compute for ${puzzles.length} puzzles on a pool of ${POOL_SIZE}`);

const pool = await new EnginePool(POOL_SIZE).init();
const bakeLog = stageTimer('bake');
let done = 0;
const results = new Map();
await mapConcurrent(jobs, POOL_SIZE, async (job) => {
  const line = await playLine(pool, job.fen, job.player, { expect: job.expect });
  results.set(job.key, {
    m: line.moves.join(' '),
    e: line.evals.join(' '),
    playerWon: line.playerWon,
    matched: line.matched,
  });
  if (++done % 10 === 0) console.error(`  ${done}/${jobs.length} lines`);
});
bakeLog(`${results.size} lines; engine ${JSON.stringify(pool.stats())}`);
await pool.close();

// Merge results into puzzles, self-healing verdict mismatches.
let mismatches = 0;
const dropped = new Set();
for (const puzzle of puzzles) {
  if (ONLY && !ONLY.includes(puzzle.id)) continue; // keep other puzzles' lines intact
  if (puzzle.place.length > 1 || !puzzle.solutions) continue;
  puzzle.lines = {};
  for (const [key, r] of results) {
    const [id, sig] = key.split('|');
    if (id !== puzzle.id) continue;
    puzzle.lines[sig] = { m: r.m, e: r.e };
    if (r.matched) continue;

    mismatches++;
    console.error(`  ⚠ ${key}: verdict mismatch (playerWon=${r.playerWon}) — self-healing`);
    const square = parseSignature(sig)[0].square;
    if (puzzle.solutions.includes(sig) && !r.playerWon) {
      // A "winning" placement failed to convert: it isn't a solution.
      puzzle.solutions = puzzle.solutions.filter((s) => s !== sig);
      if (!puzzle.solutions.length) {
        console.error(`  ✗ ${puzzle.id}: no solutions left — dropping the puzzle`);
        dropped.add(puzzle.id);
      }
    } else if (!puzzle.solutions.includes(sig) && r.playerWon) {
      // A "losing" placement won: block the square (or shrink allowed).
      if (puzzle.placement?.allowed) {
        puzzle.placement.allowed = puzzle.placement.allowed.filter((sq) => sq !== square);
        if (puzzle.placement.allowed.length < 2) {
          console.error(`  ✗ ${puzzle.id}: too few allowed squares left — dropping the puzzle`);
          dropped.add(puzzle.id);
        }
      } else {
        puzzle.placement = puzzle.placement ?? {};
        puzzle.placement.blocked = [...(puzzle.placement.blocked ?? []), square].sort();
      }
      delete puzzle.lines[sig];
    }
  }
}

// Drop lines for placements the (possibly self-healed) constraints now forbid.
let playable = puzzles.filter((p) => !dropped.has(p.id));
for (const puzzle of playable) {
  if (!puzzle.lines) continue;
  const map = fenToMap(puzzle.fen);
  for (const sig of Object.keys(puzzle.lines)) {
    const parts = parseSignature(sig);
    if (parts.some((p) => placementError(puzzle, p.square, p.type, map))) delete puzzle.lines[sig];
  }
}

const headerLine = readFileSync(FILE, 'utf8').split('\n')[0];
const banner = headerLine.startsWith('//') ? `${headerLine}\n` : '';
writeFileSync(FILE, `${banner}export default ${JSON.stringify(playable)};\n`);
const kb = Math.round(Buffer.byteLength(readFileSync(FILE)) / 1024);
console.error(`\nWrote ${playable.length} puzzles (${mismatches} mismatches healed, ${dropped.size} dropped) → ${FILE} (${kb} KB)`);
