// Precomputes full engine-vs-engine playout lines for every square a player
// can choose in each puzzle mode, so the game needs no Stockfish at runtime.
//
// For each puzzle:
//   own-turn lines (prototypes 1/2, player moves first): every legal empty
//     square except the P2-excluded ones
//   opp-turn lines (prototypes 3/4, opponent moves first): every legal empty
//     square (P4 allows them all), or all non-excluded squares if the puzzle
//     only qualifies for P3
//
// Each line is played to a terminal position and must agree with the square's
// engine-verified verdict: the solution square(s) must end in checkmate for
// the player, every other square must NOT. Mismatches retry at higher think
// times; persistent mismatches are self-healed in the puzzle data (square
// added to the exclusion list, or added to/removed from P4 solutions).
//
// Usage:  node scripts/generate-lines.mjs [--workers 3] [--file src/generated-puzzles.js]
// (Internal: --worker <jobsFile> <outFile> runs a batch in a child process.)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Chess, validateFen } from 'chess.js';
import { fenToMap, buildFen } from '../src/fen.js';

const MOVETIME_SCHEDULE = [60, 150, 300]; // retry ladder per line
const PLY_CAP = 300;
const FILES = 'abcdefgh';
const ALL_SQUARES = [];
for (let r = 1; r <= 8; r++) for (const f of FILES) ALL_SQUARES.push(f + r);

function isLegalStart(fen) {
  if (!validateFen(fen).ok) return false;
  const turn = fen.split(' ')[1];
  const flipped = fen.replace(` ${turn} `, ` ${turn === 'w' ? 'b' : 'w'} `);
  if (!validateFen(flipped).ok) return false;
  if (new Chess(flipped).isCheck()) return false;
  return !new Chess(fen).isGameOver();
}

function loadPuzzles(file) {
  const src = readFileSync(file, 'utf8');
  return JSON.parse(src.replace(/^\/\/.*\n/, '').replace(/^export default /, '').replace(/;\s*$/, ''));
}

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
const FILE = opt('file', 'src/generated-puzzles.js');
const WORKERS = Number(opt('workers', 3));
// --only p5-4,p5-5 bakes just those puzzles (for incremental, resumable runs)
const ONLY = opt('only', null)?.split(',') ?? null;

const puzzles = loadPuzzles(FILE);
const jobs = [];

for (const puzzle of puzzles) {
  if (ONLY && !ONLY.includes(puzzle.id)) continue;
  const map = fenToMap(puzzle.fen);
  const player = puzzle.player;
  const opponent = player === 'w' ? 'b' : 'w';
  const piece = { type: puzzle.place[0], color: player };

  const placements = (turn, blocked) => {
    const out = [];
    for (const sq of ALL_SQUARES) {
      if (map[sq] || blocked.includes(sq)) continue;
      const fen = buildFen({ ...map, [sq]: piece }, turn);
      if (isLegalStart(fen)) out.push({ sq, fen });
    }
    return out;
  };

  if (puzzle.candidates || puzzle.excluded) {
    for (const { sq, fen } of placements(player, puzzle.excluded ?? [])) {
      jobs.push({
        key: `${puzzle.id}|own|${sq}`,
        fen,
        player,
        expect: sq === puzzle.solution ? 'win' : 'notwin',
      });
    }
  }
  if (puzzle.p3 || puzzle.p4 || puzzle.p5) {
    const openSet = puzzle.p4 ?? puzzle.p5;
    const blocked = openSet ? [] : puzzle.p3.excluded;
    const winners = openSet ? openSet.solutions : [puzzle.p3.solution];
    for (const { sq, fen } of placements(opponent, blocked)) {
      jobs.push({
        key: `${puzzle.id}|opp|${sq}`,
        fen,
        player,
        expect: winners.includes(sq) ? 'win' : 'notwin',
      });
    }
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
for (const puzzle of puzzles) {
  if (ONLY && !ONLY.includes(puzzle.id)) continue; // keep other puzzles' baked lines intact
  puzzle.lines = {};
  for (const [key, r] of results) {
    const [id, mode, sq] = key.split('|');
    if (id !== puzzle.id) continue;
    (puzzle.lines[mode] ??= {})[sq] = { m: r.m, e: r.e };
    if (r.matched) continue;

    mismatches++;
    console.error(`  ⚠ ${key}: verdict mismatch (playerWon=${r.playerWon}) — self-healing`);
    if (mode === 'own') {
      if (sq === puzzle.solution) {
        console.error(`    solution ${sq} failed to convert — dropping P1/P2 for ${puzzle.id}`);
        delete puzzle.candidates; delete puzzle.excluded; delete puzzle.solution;
        delete puzzle.lines.own;
      } else if (r.playerWon) {
        puzzle.excluded = [...(puzzle.excluded ?? []), sq].sort();
        puzzle.candidates = puzzle.candidates?.filter((c) => c !== sq || c === puzzle.solution);
        if (puzzle.candidates && puzzle.candidates.length < 2) {
          console.error(`    too few candidates left — dropping P1 for ${puzzle.id}`);
          delete puzzle.candidates;
        }
      }
    } else {
      // P4 and P5 share open-board semantics; heal whichever set the puzzle has.
      for (const setKey of ['p4', 'p5']) {
        const set = puzzle[setKey];
        if (!set) continue;
        if (set.solutions.includes(sq) && !r.playerWon) {
          set.solutions = set.solutions.filter((s) => s !== sq);
          if (!set.solutions.length) { console.error(`    no ${setKey} solutions left — dropping for ${puzzle.id}`); delete puzzle[setKey]; }
        } else if (r.playerWon && !set.solutions.includes(sq)) {
          if (set.solutions.length < 2) set.solutions = [...set.solutions, sq].sort();
          else { console.error(`    third winning square found — dropping ${setKey} for ${puzzle.id}`); delete puzzle[setKey]; }
        }
      }
      if (puzzle.p3) {
        if (sq === puzzle.p3.solution && !r.playerWon) {
          console.error(`    P3 solution failed to convert — dropping P3 for ${puzzle.id}`);
          delete puzzle.p3;
        } else if (r.playerWon && sq !== puzzle.p3.solution && !puzzle.p3.excluded.includes(sq)) {
          puzzle.p3.excluded = [...puzzle.p3.excluded, sq].sort();
        }
      }
    }
  }
}

// Puzzles that lost every mode to self-healing are unplayable — drop them.
const playable = puzzles.filter((p) => p.candidates || p.excluded || p.p3 || p.p4 || p.p5);
if (playable.length < puzzles.length) {
  console.error(`Dropping ${puzzles.length - playable.length} puzzle(s) with no remaining mode`);
}

const banner = '// Generated by scripts/generate-puzzles.mjs + generate-lines.mjs — do not edit by hand.\n';
writeFileSync(FILE, `${banner}export default ${JSON.stringify(playable)};\n`);
const kb = Math.round(Buffer.byteLength(readFileSync(FILE)) / 1024);
console.error(`\nWrote ${results.size} lines (${mismatches} self-healed) into ${FILE} (${kb} KB)`);
