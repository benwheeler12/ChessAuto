// Outlier-discovery puzzle generator: turns feature-outlier positions (from
// scripts/analyze-positions.mjs) into open-board contract puzzles — the
// opponent moves first and at most two placements win.
//
// Selection: top N positions per heuristic (max 2 per game, deduped across
// heuristics and against positions already used by existing batches). Each
// run emits a NEW immutable batch file under src/puzzles/, auto-discovered
// by the site. Qualification runs across parallel worker processes.
//
// Usage: node scripts/generate-outliers.mjs --label "My batch label"
//   [--features data/features.jsonl] [--pgn data/lichess-games.pgn]
//   [--top 3] [--workers 3]
// (Internal: --worker <jobsFile> <outFile> runs a batch in a child process.)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Chess, validateFen } from 'chess.js';
import { fenToMap, buildFen } from '../src/fen.js';
import { readBatches, writeBatch } from './lib/batches.mjs';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const WIN_CP = 300;
const SHALLOW_WIN_CP = 350;
const EXCLUDE_VERIFY_CP = 50;
const EXCLUDE_CP = 150;
const MAX_SHALLOW_WINNERS = 6;
const MAX_SOLUTIONS = 2;
const ORIGIN_EVAL_LIMIT = 700;
const PIECE_VARIANTS = [
  ['q', 'r', 'n', 'b', 'p', 'k'],
  ['k', 'p', 'n', 'b', 'q', 'r'],
  ['n', 'b', 'p', 'q', 'r', 'k'],
];
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };
const HEURISTICS = [
  'hangingTotal', 'tension', 'contacts', 'pinsTotal', 'ringAttackMax',
  'checksStm', 'capturesStm', 'mobilityGap', 'maxPasserAdvance', 'phase',
];
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

  async function evaluate(fen, movetime) {
    let score = 0;
    engine.sendCommand(`position fen ${fen}`);
    await command(`go movetime ${movetime}`, (line) => {
      const m = /score (cp|mate) (-?\d+)/.exec(line);
      if (m) {
        score = m[1] === 'mate'
          ? Math.sign(Number(m[2])) * (10000 - Math.abs(Number(m[2])))
          : Number(m[2]);
      }
      return line.startsWith('bestmove');
    });
    return score;
  }

  /** Try to qualify one outlier position; returns a puzzle body or a log. */
  async function qualify(job) {
    const { row, foundBy, meta, variant } = job;
    const player = row.fen.split(' ')[1];
    const opponent = player === 'w' ? 'b' : 'w';
    const map = fenToMap(row.fen);

    const originCp = await evaluate(row.fen, SHALLOW_MS);
    if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) {
      return { log: `skip g${row.game} ply${row.ply}: origin ${originCp}cp (one-sided)` };
    }

    const prio = PIECE_VARIANTS[variant % PIECE_VARIANTS.length];
    const sorted = Object.entries(map)
      .filter(([, p]) => p.color === player && prio.includes(p.type))
      .sort(([sqA, a], [sqB, b]) => {
        const d = prio.indexOf(a.type) - prio.indexOf(b.type);
        if (d) return d;
        if (a.type === 'p') {
          return player === 'w' ? Number(sqB[1]) - Number(sqA[1]) : Number(sqA[1]) - Number(sqB[1]);
        }
        return 0;
      });
    const firstOfType = [];
    const extras = [];
    const tried = new Set();
    for (const entry of sorted) {
      if (tried.has(entry[1].type)) extras.push(entry);
      else { tried.add(entry[1].type); firstOfType.push(entry); }
    }
    const removable = [...firstOfType, ...extras].slice(0, 6);

    const reasons = [];
    for (const [origin, piece] of removable) {
      const baseMap = { ...map };
      delete baseMap[origin];
      if (!isLegalStart(buildFen(baseMap, opponent)) && piece.type !== 'k') {
        reasons.push(`${piece.type}@${origin}: illegal base`);
        continue;
      }
      const scans = [];
      for (const sq of ALL_SQUARES) {
        if (baseMap[sq]) continue;
        const fen = buildFen({ ...baseMap, [sq]: piece }, opponent);
        if (!isLegalStart(fen)) continue;
        const cpSide = await evaluate(fen, SHALLOW_MS);
        scans.push({ sq, fen, cp: -cpSide }); // player perspective
      }
      const shallowWinners = scans.filter((s) => s.cp >= SHALLOW_WIN_CP).sort((a, b) => b.cp - a.cp);
      if (!shallowWinners.length) { reasons.push(`${piece.type}@${origin}: no winning square`); continue; }
      if (shallowWinners.length > MAX_SHALLOW_WINNERS) {
        reasons.push(`${piece.type}@${origin}: ${shallowWinners.length} shallow winners`);
        continue;
      }
      const deepBySq = new Map();
      const deepEval = async (cand) => {
        if (!deepBySq.has(cand.sq)) deepBySq.set(cand.sq, -(await evaluate(cand.fen, DEEP_MS)));
        return deepBySq.get(cand.sq);
      };
      let winner = null;
      for (const cand of shallowWinners.slice(0, 3)) {
        const deep = await deepEval(cand);
        if (deep >= WIN_CP) { winner = { ...cand, cp: deep }; break; }
      }
      if (!winner) { reasons.push(`${piece.type}@${origin}: no deep-verified winner`); continue; }
      for (const cand of scans) {
        if (cand.cp >= EXCLUDE_VERIFY_CP) await deepEval(cand);
      }
      const looseWins = [...deepBySq.entries()].filter(([, d]) => d >= EXCLUDE_CP).map(([sq]) => sq).sort();
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

  const results = [];
  for (const [i, job] of jobs.entries()) {
    const result = await qualify(job);
    console.error(`  [worker ${i + 1}/${jobs.length}] ${result.log}`);
    results.push({ order: job.order, puzzle: result.puzzle ?? null });
  }
  writeFileSync(outFile, JSON.stringify(results));
  process.exit(0);
}

// ---------------------------------------------------------------- parent ---
const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const FEATURES_FILE = opt('features', 'data/features.jsonl');
const PGN_FILE = opt('pgn', 'data/lichess-games.pgn');
const TOP_N = Number(opt('top', 3));
const WORKERS = Number(opt('workers', 3));
const LABEL = opt('label', null);
if (!LABEL) {
  console.error('A --label for the new batch is required (shown in the collection dropdown).');
  process.exit(1);
}

// Positions already used by ANY existing batch are off-limits.
const covered = new Set();
for (const { puzzles } of readBatches()) {
  for (const p of puzzles) covered.add(`${p.meta?.source?.site}|${p.meta?.source?.moveNumber}|${p.player}`);
}

// Select the top-N outlier positions per heuristic.
const rows = readFileSync(FEATURES_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const selected = new Map();
for (const feature of HEURISTICS) {
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

const games = readFileSync(PGN_FILE, 'utf8').split(/\n\n(?=\[Event )/);
const nameOf = (idx) => {
  const chunk = games[idx] ?? '';
  const get = (h) => chunk.match(new RegExp(`\\[${h} "([^"]*)"`))?.[1] ?? '?';
  return { white: get('White'), black: get('Black'), site: get('Site') };
};

const jobs = [];
for (const { row, foundBy } of selected.values()) {
  const meta = nameOf(row.game);
  const player = row.fen.split(' ')[1];
  if (covered.has(`${meta.site}|${row.moveNo}|${player}`)) continue;
  jobs.push({ order: jobs.length, row, foundBy, meta, variant: jobs.length });
}
console.error(`${selected.size} outliers selected → ${jobs.length} new positions to qualify on ${WORKERS} workers`);

const tmp = mkdtempSync(join(tmpdir(), 'chessauto-p5-'));
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

const fresh = [];
for (let i = 0; i < WORKERS; i++) {
  try {
    for (const r of JSON.parse(readFileSync(join(tmp, `out-${i}.json`), 'utf8'))) {
      if (r.puzzle) fresh.push(r);
    }
  } catch { /* empty batch */ }
}
rmSync(tmp, { recursive: true, force: true });
fresh.sort((a, b) => a.order - b.order);

const { path: outFile, batchId, count } = writeBatch({
  label: LABEL,
  generator: `scripts/generate-outliers.mjs (feature outliers, top ${TOP_N} × ${HEURISTICS.length} heuristics)`,
  puzzles: fresh.map(({ puzzle }) => puzzle),
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
console.error('Next: optionally bake lines with  node scripts/generate-lines.mjs --file ' + outFile);
