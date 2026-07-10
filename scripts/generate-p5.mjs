// Prototype 5 generator: turns feature-outlier positions (from
// scripts/analyze-positions.mjs) into P4-rule puzzles — opponent moves
// first, open board, at most two winning placement squares.
//
// Selection: top N positions per heuristic (max 2 per game, deduped across
// heuristics). Each puzzle records which heuristics discovered it, so
// playtest feedback maps back to features.
//
// Usage: node scripts/generate-p5.mjs [--features data/features.jsonl]
//   [--pgn data/lichess-games.pgn] [--top 3] [--out src/generated-puzzles-p5.js]

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Chess, validateFen } from 'chess.js';
import { fenToMap, buildFen } from '../src/fen.js';

const require = createRequire(import.meta.url);

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const FEATURES_FILE = opt('features', 'data/features.jsonl');
const PGN_FILE = opt('pgn', 'data/lichess-games.pgn');
const TOP_N = Number(opt('top', 3));
const OUT = opt('out', 'src/generated-puzzles-p5.js');

const HEURISTICS = [
  'hangingTotal', 'tension', 'contacts', 'pinsTotal', 'ringAttackMax',
  'checksStm', 'capturesStm', 'mobilityGap', 'maxPasserAdvance', 'phase',
];
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
const FILES = 'abcdefgh';
const ALL_SQUARES = [];
for (let r = 1; r <= 8; r++) for (const f of FILES) ALL_SQUARES.push(f + r);

// ---- Engine ----
const init = require('stockfish');
const engine = await init('lite-single');
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

function isLegalStart(fen) {
  if (!validateFen(fen).ok) return false;
  const turn = fen.split(' ')[1];
  const flipped = fen.replace(` ${turn} `, ` ${turn === 'w' ? 'b' : 'w'} `);
  if (!validateFen(flipped).ok) return false;
  if (new Chess(flipped).isCheck()) return false;
  return !new Chess(fen).isGameOver();
}

// ---- Select outlier positions ----
const rows = readFileSync(FEATURES_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const selected = new Map(); // key game|ply -> { row, foundBy: [] }
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
console.error(`${selected.size} unique outlier positions selected (top ${TOP_N} × ${HEURISTICS.length} heuristics)`);

// Player names per game index for puzzle naming
const games = readFileSync(PGN_FILE, 'utf8').split(/\n\n(?=\[Event )/);
const nameOf = (idx) => {
  const chunk = games[idx] ?? '';
  const get = (h) => chunk.match(new RegExp(`\\[${h} "([^"]*)"`))?.[1] ?? '?';
  return { white: get('White'), black: get('Black'), site: get('Site') };
};

// ---- Qualify each position under P4 rules (opponent moves first) ----
const puzzles = [];
for (const { row, foundBy } of selected.values()) {
  const player = row.fen.split(' ')[1];
  const opponent = player === 'w' ? 'b' : 'w';
  const map = fenToMap(row.fen);

  const originCp = await evaluate(row.fen, SHALLOW_MS);
  if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) {
    console.error(`  skip g${row.game} ply${row.ply}: origin ${originCp}cp (one-sided)`);
    continue;
  }

  const prio = PIECE_VARIANTS[puzzles.length % PIECE_VARIANTS.length];
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
  // Try up to 6 removals: every distinct type first, then second pieces of
  // already-tried types (e.g. the other rook).
  const firstOfType = [];
  const extras = [];
  const tried = new Set();
  for (const entry of sorted) {
    if (tried.has(entry[1].type)) extras.push(entry);
    else { tried.add(entry[1].type); firstOfType.push(entry); }
  }
  const removable = [...firstOfType, ...extras].slice(0, 6);

  let qualified = false;
  const reasons = [];
  for (const [origin, piece] of removable) {
    const baseMap = { ...map };
    delete baseMap[origin];
    if (!isLegalStart(buildFen(baseMap, opponent)) && piece.type !== 'k') {
      reasons.push(`${piece.type}@${origin}: illegal base`);
      continue;
    }

    // Shallow scan of every legal placement with the opponent to move.
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

    const meta = nameOf(row.game);
    puzzles.push({
      id: `p5-${puzzles.length + 1}`,
      name: `${meta.white}–${meta.black} (Lichess)`,
      description:
        `From a ${row.fen.split(' ')[1] === 'w' ? '' : ''}Lichess game (${meta.site}), around move ${row.moveNo}. ` +
        `Missing piece: a ${PIECE_NAMES[piece.type]}. Discovered by: ${foundBy.join(', ')}.`,
      fen: buildFen(baseMap, player),
      player,
      place: [piece.type],
      p5: { solutions: looseWins, winCp: winner.cp, foundBy },
      source: {
        white: meta.white, black: meta.black, event: 'Lichess', site: meta.site,
        moveNumber: row.moveNo, removedFrom: origin,
      },
    });
    console.error(
      `  ✓ p5-${puzzles.length}: g${row.game} ply${row.ply} remove ${piece.type.toUpperCase()} from ${origin} — ` +
      `solutions [${looseWins.join(' ')}] (+${(winner.cp / 100).toFixed(1)}) — via ${foundBy.join(',')}`,
    );
    qualified = true;
    break; // one puzzle per position
  }
  if (!qualified && reasons.length) {
    console.error(`  ✗ g${row.game} ply${row.ply} (${foundBy.join(',')}): ${reasons.join('; ')}`);
  }
}

const banner = '// Generated by scripts/generate-p5.mjs — do not edit by hand.\n';
writeFileSync(OUT, `${banner}export default ${JSON.stringify(puzzles)};\n`);
console.error(`\nWrote ${puzzles.length} P5 puzzles to ${OUT}`);
process.exit(0);
