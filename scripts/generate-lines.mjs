// Precomputes full engine-vs-engine playout lines for puzzles, so the game
// needs no Stockfish at runtime. Operates on contract batch files (see
// src/puzzle-contract.js): for every reachable placement of a puzzle that
// carries verdicts (solutions), a line is played to a terminal position and
// must agree with the verdict — solutions must end in checkmate for the
// player, everything else must NOT. Mismatches retry at higher think times;
// persistent mismatches are self-healed (square blocked / solution removed /
// puzzle dropped).
//
// Multi-piece puzzles and puzzles without solutions are skipped (no line
// space or nothing to verify).
//
// Usage:  node scripts/generate-lines.mjs --file src/puzzles/batch-XXX.js
//         [--workers 3] [--only <id>,<id>]
// (Internal: --worker <jobsFile> <outFile> runs a batch in a child process.)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Chess } from 'chess.js';
import {
  signature, parseSignature, startFen, placementError, placeableSquares,
} from '../src/puzzle-contract.js';
import { parseBatchFile } from './lib/batches.mjs';

const MOVETIME_SCHEDULE = [60, 150, 300]; // retry ladder per line
const PLY_CAP = 300;

// ---------------------------------------------------------------- worker ---
if (process.argv[2] === '--worker') {
  const [jobsFile, outFile] = process.argv.slice(3);
  const jobs = JSON.parse(readFileSync(jobsFile, 'utf8'));
  const require = createRequire(import.meta.url);
  const engine = await require('stockfish')('lite-single');
  const listeners = new Set();
  engine.listener = (line) => { for (const l of [...listeners]) l(line); };
  const command = (cmd, until) => new Promise((resolve) => {
    const l = (line) => { if (until(line)) { listeners.delete(l); resolve(line); } };
    listeners.add(l);
    engine.sendCommand(cmd);
  });
  await command('uci', (l) => l === 'uciok');
  engine.sendCommand('setoption name Hash value 64');
  await command('isready', (l) => l === 'readyok');

  async function bestMove(startFen, moves, movetime) {
    let score = null;
    engine.sendCommand(`position fen ${startFen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
    const line = await command(`go movetime ${movetime}`, (l) => {
      const m = /score (cp|mate) (-?\d+)/.exec(l);
      if (m) {
        score = m[1] === 'mate'
          ? Math.sign(Number(m[2])) * (10000 - Math.abs(Number(m[2])))
          : Number(m[2]);
      }
      return l.startsWith('bestmove');
    });
    return { uci: line.split(/\s+/)[1], score };
  }

  async function playLine(startFen, player, movetime) {
    const game = new Chess(startFen);
    const moves = [];
    const evals = [];
    while (!game.isGameOver() && moves.length < PLY_CAP) {
      const side = game.turn();
      const { uci, score } = await bestMove(startFen, moves, movetime);
      if (!uci || uci === '(none)') break;
      game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      moves.push(uci);
      evals.push(side === 'w' ? (score ?? 0) : -(score ?? 0)); // white perspective
    }
    const playerWon = game.isCheckmate() && game.turn() !== player;
    const terminal = game.isGameOver();
    return { moves, evals, playerWon, terminal };
  }

  const results = [];
  let done = 0;
  for (const job of jobs) {
    let line = null;
    let matched = false;
    for (const movetime of MOVETIME_SCHEDULE) {
      line = await playLine(job.fen, job.player, movetime);
      const ok = line.terminal && (job.expect === 'win' ? line.playerWon : !line.playerWon);
      if (ok) { matched = true; break; }
    }
    results.push({
      key: job.key,
      m: line.moves.join(' '),
      e: line.evals.join(' '),
      playerWon: line.playerWon,
      matched,
    });
    done++;
    if (done % 10 === 0) console.error(`  worker: ${done}/${jobs.length} lines`);
  }
  writeFileSync(outFile, JSON.stringify(results));
  process.exit(0);
}

// ---------------------------------------------------------------- parent ---
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const FILE = opt('file', null);
if (!FILE) {
  console.error('Usage: node scripts/generate-lines.mjs --file src/puzzles/batch-XXX.js [--workers 3] [--only id,id]');
  process.exit(1);
}
const WORKERS = Number(opt('workers', 3));
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

console.error(`${jobs.length} lines to compute for ${puzzles.length} puzzles on ${WORKERS} workers`);

const tmp = mkdtempSync(join(tmpdir(), 'chessauto-lines-'));
const self = fileURLToPath(import.meta.url);
const batches = Array.from({ length: WORKERS }, () => []);
jobs.forEach((job, i) => batches[i % WORKERS].push(job));

await Promise.all(batches.map((batch, i) => {
  if (!batch.length) return Promise.resolve();
  const jobsFile = join(tmp, `jobs-${i}.json`);
  const outFile = join(tmp, `out-${i}.json`);
  writeFileSync(jobsFile, JSON.stringify(batch));
  return new Promise((resolve, reject) => {
    const child = fork(self, ['--worker', jobsFile, outFile], { stdio: 'inherit' });
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`worker ${i} exited ${code}`))));
  });
}));

const results = new Map();
for (let i = 0; i < WORKERS; i++) {
  try {
    for (const r of JSON.parse(readFileSync(join(tmp, `out-${i}.json`), 'utf8'))) {
      results.set(r.key, r);
    }
  } catch { /* empty batch */ }
}
rmSync(tmp, { recursive: true, force: true });

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
        console.error(`    no solutions left — dropping ${puzzle.id}`);
        dropped.add(puzzle.id);
      }
    } else if (!puzzle.solutions.includes(sig) && r.playerWon) {
      // A "losing" placement won. Constrain it away per the puzzle's style:
      // remove it from an allowed list, otherwise block the square.
      if (puzzle.placement?.allowed) {
        puzzle.placement.allowed = puzzle.placement.allowed.filter((sq) => sq !== square);
        if (puzzle.placement.allowed.length < 2) {
          console.error(`    too few allowed squares left — dropping ${puzzle.id}`);
          dropped.add(puzzle.id);
        }
      } else {
        puzzle.placement ??= {};
        puzzle.placement.blocked = [...(puzzle.placement.blocked ?? []), square].sort();
      }
      delete puzzle.lines[sig]; // no longer reachable
    }
  }
}

const playable = puzzles.filter((p) => !dropped.has(p.id));
if (playable.length < puzzles.length) {
  console.error(`Dropping ${puzzles.length - playable.length} puzzle(s) after self-healing`);
}

const headerLine = readFileSync(FILE, 'utf8').split('\n')[0];
const banner = headerLine.startsWith('//') ? headerLine + '\n' : '// Puzzle batch — do not edit by hand.\n';
writeFileSync(FILE, `${banner}export default ${JSON.stringify(playable)};\n`);
const kb = Math.round(Buffer.byteLength(readFileSync(FILE)) / 1024);
console.error(`\nWrote ${results.size} lines (${mismatches} self-healed) into ${FILE} (${kb} KB)`);
