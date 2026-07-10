// Sector-build puzzle generator: 3×3-zone multi-piece placement puzzles.
//
// The idea: find positions where the player is winning but the OPPONENT is
// to move, locate a 3×3 sector of the board that is already tactically hot
// (several pieces of both colors, lots of contact), remove the player's
// pieces from that sector, and confirm with the engine that only a few ways
// of putting them back inside the sector keep the position winning. The
// player then has to reassemble a working piece STRUCTURE, not just find
// one strong square.
//
// Candidate positions come from the puzzle-lab features file
// (scripts/analyze-positions.mjs), ranked by static sharpness. Each run
// emits a NEW immutable batch under src/puzzles/.
//
// Usage: node scripts/generate-sectors.mjs --label "My batch label"
//   [--features data/features.jsonl] [--pgn data/lichess-games.pgn]
//   [--top 300] [--offset 0] [--workers 3]
// --offset skips the first N candidates (already scanned by a previous run)
// so follow-up runs explore the next band of sharp positions.
// (Internal: --worker <jobsFile> <outFile> runs a batch in a child process.)

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { Chess, validateFen } from 'chess.js';
import { fenToMap, buildFen } from '../src/fen.js';
import { signature } from '../src/puzzle-contract.js';
import { readBatches, writeBatch } from './lib/batches.mjs';

const SHALLOW_MS = 80;
const DEEP_MS = 700;
const ORIGIN_WIN_CP = 300; // the source position must already be winning
const ORIGIN_MAX_CP = 1200; // …but not so crushing that anything wins
// The player's win must be dynamic, not material: with a material edge the
// removed pieces win from almost anywhere and the sector never gets sharp.
const MAX_MATERIAL_EDGE = 1;
const WIN_CP = 300; // deep-verified "this combo wins"
const LOOSE_WIN_CP = 150; // anything at/above this counts as a solution
const DEEP_VERIFY_CP = 50; // shallow gray zone that gets a deep look
const MAX_SOLUTIONS = 3; // "one or very few" winning combos
const MAX_SHALLOW_WINNERS = 6; // more = placement isn't sharp, skip sector
const MAX_COMBOS = 400; // enumeration budget per sector
const MIN_REMOVED = 2;
const MAX_REMOVED = 3;
const SECTORS_PER_POSITION = 3; // try the top-scoring sectors only
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };
const FILES = 'abcdefgh';

function isLegalStart(fen) {
  if (!validateFen(fen).ok) return false;
  const turn = fen.split(' ')[1];
  const flipped = fen.replace(` ${turn} `, ` ${turn === 'w' ? 'b' : 'w'} `);
  if (!validateFen(flipped).ok) return false;
  if (new Chess(flipped).isCheck()) return false;
  return !new Chess(fen).isGameOver();
}

/** The 9 squares of the 3×3 sector anchored at its bottom-left corner. */
function sectorSquares(fileIdx, rank) {
  const squares = [];
  for (let f = fileIdx; f < fileIdx + 3; f++) {
    for (let r = rank; r < rank + 3; r++) squares.push(FILES[f] + r);
  }
  return squares;
}

/** All ways to put `types` onto distinct squares from `empties`, deduped by signature. */
function enumerateCombos(types, empties) {
  const out = new Map(); // signature -> placements
  const recur = (i, chosen, used) => {
    if (out.size > MAX_COMBOS) return;
    if (i === types.length) {
      const placements = chosen.map((c) => ({ ...c }));
      out.set(signature(placements), placements);
      return;
    }
    for (const square of empties) {
      if (used.has(square)) continue;
      chosen.push({ type: types[i], square });
      used.add(square);
      recur(i + 1, chosen, used);
      chosen.pop();
      used.delete(square);
    }
  };
  recur(0, [], new Set());
  return out;
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

  /** Score every 3×3 sector of the position; keep the qualifying ones. */
  function candidateSectors(map, fen, player) {
    const game = new Chess(fen);
    const opponent = player === 'w' ? 'b' : 'w';
    const sectors = [];
    for (let f = 0; f <= 5; f++) {
      for (let r = 1; r <= 6; r++) {
        const squares = sectorSquares(f, r);
        const mine = squares.filter((sq) => map[sq]?.color === player && map[sq].type !== 'k');
        const theirs = squares.filter((sq) => map[sq]?.color === opponent);
        if (squares.some((sq) => map[sq]?.type === 'k' && map[sq].color === player)) continue;
        if (mine.length < MIN_REMOVED || mine.length > MAX_REMOVED || !theirs.length) continue;
        // Tactical heat: occupied sector squares under attack by the other side.
        let contacts = 0;
        for (const sq of squares) {
          if (!map[sq]) continue;
          if (game.isAttacked(sq, map[sq].color === 'w' ? 'b' : 'w')) contacts++;
        }
        sectors.push({ anchor: FILES[f] + r, squares, mine, contacts, score: mine.length * 2 + theirs.length + contacts * 2 });
      }
    }
    return sectors.sort((a, b) => b.score - a.score).slice(0, SECTORS_PER_POSITION);
  }

  /** Try to qualify one position; returns a puzzle body or a log line. */
  async function qualify(job) {
    const { row, meta } = job;
    const opponent = row.fen.split(' ')[1]; // opponent is to move
    const player = opponent === 'w' ? 'b' : 'w';

    const originCp = await evaluate(row.fen, SHALLOW_MS);
    if (-originCp < ORIGIN_WIN_CP || -originCp > ORIGIN_MAX_CP) {
      return { log: `skip g${row.game} ply${row.ply}: player eval ${-originCp}cp (want ${ORIGIN_WIN_CP}..${ORIGIN_MAX_CP})` };
    }

    const map = fenToMap(row.fen);
    const sectors = candidateSectors(map, row.fen, player);
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
      if (combos.size > MAX_COMBOS) {
        reasons.push(`${sector.anchor}: ${combos.size}+ combos`);
        continue;
      }

      const scans = [];
      for (const [sig, placements] of combos) {
        const posMap = { ...baseMap };
        for (const p of placements) posMap[p.square] = { type: p.type, color: player };
        const fen = buildFen(posMap, opponent);
        if (!isLegalStart(fen)) continue;
        scans.push({ sig, fen, cp: -(await evaluate(fen, SHALLOW_MS)) });
      }
      const shallowWinners = scans.filter((s) => s.cp >= WIN_CP);
      if (!shallowWinners.length) { reasons.push(`${sector.anchor}: no winning combo`); continue; }
      if (shallowWinners.length > MAX_SHALLOW_WINNERS) {
        reasons.push(`${sector.anchor}: ${shallowWinners.length} shallow-winning combos`);
        continue;
      }

      const deep = new Map();
      for (const scan of scans) {
        if (scan.cp >= DEEP_VERIFY_CP) deep.set(scan.sig, -(await evaluate(scan.fen, DEEP_MS)));
      }
      const looseWins = [...deep.entries()].filter(([, cp]) => cp >= LOOSE_WIN_CP).map(([sig]) => sig).sort();
      const winners = [...deep.values()].filter((cp) => cp >= WIN_CP);
      if (!winners.length) { reasons.push(`${sector.anchor}: no deep-verified winner`); continue; }
      if (looseWins.length > MAX_SOLUTIONS) {
        reasons.push(`${sector.anchor}: ${looseWins.length} winning combos`);
        continue;
      }

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
            winCp: Math.max(...winners),
            source: {
              white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
              moveNumber: row.moveNo, ply: row.ply,
              removedFrom: sector.mine.map((sq, i) => `${removedTypes[i]}@${sq}`),
            },
          },
        },
        log: `✓ g${row.game} ply${row.ply} sector ${sector.anchor}: remove [${removedTypes.join(' ').toUpperCase()}] — ` +
          `${looseWins.length} winning combo(s), best +${(Math.max(...winners) / 100).toFixed(1)}`,
      };
    }
    return { log: `✗ g${row.game} ply${row.ply}: ${reasons.join('; ')}` };
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
const TOP_N = Number(opt('top', 300));
const OFFSET = Number(opt('offset', 0));
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

// Rank sampled positions by static sharpness — busy, contact-heavy
// middlegames are where hot sectors live. Max 2 per game for variety.
// Keep only positions where the player (the side NOT to move) has no real
// material edge: if they're winning anyway, the win is dynamic and the
// placement of the removed pieces actually matters.
const rows = readFileSync(FEATURES_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l))
  .filter((r) => {
    const playerIsWhite = r.turn === 'b';
    const edge = playerIsWhite ? r.materialW - r.materialB : r.materialB - r.materialW;
    return edge <= MAX_MATERIAL_EDGE;
  });
const sharpness = (r) => r.tension * 2 + r.contacts + r.hangingTotal + r.pinsTotal;
const games = readFileSync(PGN_FILE, 'utf8').split(/\n\n(?=\[Event )/);
const nameOf = (idx) => {
  const chunk = games[idx] ?? '';
  const get = (h) => chunk.match(new RegExp(`\\[${h} "([^"]*)"`))?.[1] ?? '?';
  return { white: get('White'), black: get('Black'), site: get('Site') };
};

const perGame = new Map();
const jobs = [];
let skipped = 0;
for (const row of [...rows].sort((a, b) => sharpness(b) - sharpness(a))) {
  if (jobs.length >= TOP_N) break;
  const n = perGame.get(row.game) ?? 0;
  if (n >= 2) continue;
  const meta = nameOf(row.game);
  const player = row.fen.split(' ')[1] === 'w' ? 'b' : 'w'; // opponent moves first
  if (covered.has(`${meta.site}|${row.moveNo}|${player}`)) continue;
  perGame.set(row.game, n + 1);
  if (skipped < OFFSET) { skipped++; continue; }
  jobs.push({ order: jobs.length, row, meta });
}
console.error(`${jobs.length} sharp positions (offset ${OFFSET}) to qualify on ${WORKERS} workers`);

const tmp = mkdtempSync(join(tmpdir(), 'chessauto-sectors-'));
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

if (!fresh.length) {
  console.error('\nNo positions qualified — nothing written.');
  process.exit(1);
}
const { path: outFile, batchId, count } = writeBatch({
  label: LABEL,
  generator: `scripts/generate-sectors.mjs (3×3 hot sectors, top ${TOP_N} sharp positions)`,
  puzzles: fresh.map(({ puzzle }) => puzzle),
});
console.error(`\nWrote ${count} puzzles to ${outFile} (batch ${batchId})`);
