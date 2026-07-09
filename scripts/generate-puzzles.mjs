// Puzzle generator: mines grandmaster games for sharp piece-placement puzzles.
//
// For sampled positions inside each game, one of the side-to-move's pieces is
// removed and Stockfish evaluates putting it back on every legal empty square.
// A position becomes a puzzle when there is a placement that is completely
// winning for the player and at least two plausible placements that are
// clearly losing — the player will be offered exactly those 2–3 squares.
//
// Usage:
//   node scripts/generate-puzzles.mjs [--in data/games.pgn]
//     [--out src/generated-puzzles.js] [--max 12] [--per-game 2]
//     [--shallow 80] [--deep 700]
//
// Output: an ES module exporting the puzzle array, consumed by src/puzzles.js.

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { Chess, validateFen } from 'chess.js';

const require = createRequire(import.meta.url);

// ---- Options ----
const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const IN_FILE = opt('in', 'data/games.pgn');
const OUT_FILE = opt('out', 'src/generated-puzzles.js');
const MAX_PUZZLES = Number(opt('max', 12));
const PER_GAME = Number(opt('per-game', 2));
const SHALLOW_MS = Number(opt('shallow', 80)); // full-board placement scan
const DEEP_MS = Number(opt('deep', 700)); // verification of chosen candidates

const WIN_CP = 300; // "completely winning" for the player
const LOSS_CP = -300; // "clearly losing" for the player
const SHALLOW_WIN_CP = 350; // pre-filter margins (shallow search is noisy)
const SHALLOW_LOSS_CP = -250;
const MAX_SHALLOW_WINNERS = 6; // more than this = placement isn't precise/sharp
const ORIGIN_EVAL_LIMIT = 700; // skip positions that were already blowouts
const FIRST_PLY = 16; // skip the opening
const LAST_PLY_MARGIN = 6; // skip the very end of the game
const PLY_STEP = 3;
const PIECE_PRIORITY = ['q', 'r', 'n', 'b']; // pieces considered for removal
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn' };

const FILES = 'abcdefgh';
const ALL_SQUARES = [];
for (let r = 1; r <= 8; r++) for (const f of FILES) ALL_SQUARES.push(f + r);

// ---- Engine (Stockfish WASM in-process) ----
class NodeEngine {
  static async create() {
    const init = require('stockfish');
    const self = new NodeEngine();
    self.engine = await init('lite-single');
    self.listeners = new Set();
    self.engine.listener = (line) => {
      for (const l of [...self.listeners]) l(line);
    };
    await self.command('uci', (l) => l === 'uciok');
    self.engine.sendCommand('setoption name Hash value 64');
    await self.command('isready', (l) => l === 'readyok');
    return self;
  }

  command(cmd, until) {
    return new Promise((resolve) => {
      const listener = (line) => {
        if (until(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
      this.engine.sendCommand(cmd);
    });
  }

  /** Evaluate a position; returns centipawns from the side-to-move's view (mates mapped to ±9xxx). */
  async evaluate(fen, movetimeMs) {
    let score = 0;
    this.engine.sendCommand(`position fen ${fen}`);
    await this.command(`go movetime ${movetimeMs}`, (line) => {
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
}

// ---- FEN helpers (mirror src/fen.js, duplicated to keep this script standalone) ----
function fenToMap(fen) {
  const map = {};
  fen.split(' ')[0].split('/').forEach((row, r) => {
    let file = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) file += Number(ch);
      else {
        map[FILES[file] + (8 - r)] = { type: ch.toLowerCase(), color: ch === ch.toUpperCase() ? 'w' : 'b' };
        file++;
      }
    }
  });
  return map;
}

function mapToFen(map, turn) {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = '';
    let empty = 0;
    for (const f of FILES) {
      const piece = map[f + r];
      if (piece) {
        if (empty) { row += empty; empty = 0; }
        row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
      } else empty++;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return `${rows.join('/')} ${turn} - - 0 1`;
}

/** Same legality rule the game enforces: valid FEN and the opponent not already in check. */
function isLegalStart(fen, player) {
  if (!validateFen(fen).ok) return false;
  const flipped = fen.replace(` ${player} `, ` ${player === 'w' ? 'b' : 'w'} `);
  if (!validateFen(flipped).ok) return false;
  if (new Chess(flipped).isCheck()) return false;
  const game = new Chess(fen);
  return !game.isGameOver();
}

function squareDistance(a, b) {
  return Math.max(Math.abs(FILES.indexOf(a[0]) - FILES.indexOf(b[0])), Math.abs(a[1] - b[1]));
}

// ---- PGN parsing ----
function splitPgn(text) {
  return text.split(/\n\n(?=\[)/).map((s) => s.trim()).filter(Boolean)
    // Re-join header/movetext pairs: a chunk starting with '[' that has no move text belongs with the next chunk.
    .reduce((games, chunk) => {
      const last = games[games.length - 1];
      if (last && !/\n\n/.test(last) && last.startsWith('[') && !/\d+\./.test(last)) {
        games[games.length - 1] = `${last}\n\n${chunk}`;
      } else {
        games.push(chunk);
      }
      return games;
    }, []);
}

// ---- Generation ----
const engine = await NodeEngine.create();
const pgnText = readFileSync(IN_FILE, 'utf8');
const puzzles = [];
const seen = new Set();

for (const pgn of splitPgn(pgnText)) {
  if (puzzles.length >= MAX_PUZZLES) break;
  const game = new Chess();
  try {
    game.loadPgn(pgn);
  } catch (err) {
    console.error(`✗ Skipping unparseable game: ${err.message.slice(0, 100)}`);
    continue;
  }
  const header = game.getHeaders();
  const label = `${header.White ?? '?'} vs ${header.Black ?? '?'}, ${header.Event ?? '?'} ${(header.Date ?? '').slice(0, 4)}`;
  const moves = game.history();
  console.error(`\n=== ${label} (${moves.length} plies)`);
  if (moves.length < FIRST_PLY + LAST_PLY_MARGIN) {
    console.error('  (too short, skipping)');
    continue;
  }

  const replay = new Chess();
  const positions = [];
  for (let ply = 0; ply < moves.length; ply++) {
    replay.move(moves[ply]);
    if (ply + 1 >= FIRST_PLY && ply + 1 <= moves.length - LAST_PLY_MARGIN && (ply + 1) % PLY_STEP === 0) {
      positions.push({ fen: replay.fen(), moveNumber: replay.moveNumber(), ply: ply + 1 });
    }
  }

  let fromThisGame = 0;
  for (const pos of positions) {
    if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

    const player = pos.fen.split(' ')[1];
    const map = fenToMap(pos.fen);

    // Skip positions that were already completely one-sided in the source game.
    const originCp = await engine.evaluate(pos.fen, SHALLOW_MS);
    if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) continue;

    // Candidate pieces to remove, strongest first.
    const removable = Object.entries(map)
      .filter(([, p]) => p.color === player && PIECE_PRIORITY.includes(p.type))
      .sort(([, a], [, b]) => PIECE_PRIORITY.indexOf(a.type) - PIECE_PRIORITY.indexOf(b.type));

    for (const [origin, piece] of removable.slice(0, 2)) {
      if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

      const baseMap = { ...map };
      delete baseMap[origin];
      const baseFen = mapToFen(baseMap, player);
      if (!isLegalStart(baseFen, player)) continue; // removal exposed a check
      const key = `${baseFen}|${piece.type}`;
      if (seen.has(key)) continue;

      // Shallow scan of every legal placement square.
      const scans = [];
      for (const sq of ALL_SQUARES) {
        if (baseMap[sq]) continue;
        const candMap = { ...baseMap, [sq]: piece };
        const fen = mapToFen(candMap, player);
        if (!isLegalStart(fen, player)) continue;
        const cpSide = await engine.evaluate(fen, SHALLOW_MS);
        const cp = player === fen.split(' ')[1] ? cpSide : -cpSide; // side to move IS the player
        scans.push({ sq, fen, cp });
      }

      const shallowWinners = scans.filter((s) => s.cp >= SHALLOW_WIN_CP).sort((a, b) => b.cp - a.cp);
      const shallowLosers = scans.filter((s) => s.cp <= SHALLOW_LOSS_CP).sort((a, b) => b.cp - a.cp);
      if (!shallowWinners.length || shallowLosers.length < 2) continue;
      if (shallowWinners.length > MAX_SHALLOW_WINNERS) continue; // not sharp: too many squares win

      // Deep verification: confirm one winner…
      let winner = null;
      for (const cand of shallowWinners.slice(0, 3)) {
        const deep = await engine.evaluate(cand.fen, DEEP_MS);
        if (deep >= WIN_CP) { winner = { ...cand, cp: deep }; break; }
      }
      if (!winner) continue;

      // …and two losers, preferring tricky ones (least-lost eval, near the winning square).
      const losers = [];
      const ranked = shallowLosers
        .sort((a, b) => (b.cp - a.cp) || (squareDistance(a.sq, winner.sq) - squareDistance(b.sq, winner.sq)));
      for (const cand of ranked) {
        if (losers.length >= 2) break;
        const deep = await engine.evaluate(cand.fen, DEEP_MS);
        if (deep <= LOSS_CP) losers.push({ ...cand, cp: deep });
      }
      if (losers.length < 2) continue;

      const candidates = [winner.sq, ...losers.map((l) => l.sq)].sort();
      const lastName = (s) => (s ?? '?').split(',')[0].trim();
      seen.add(key);
      fromThisGame++;
      puzzles.push({
        id: `gm-${puzzles.length + 1}`,
        name: `${lastName(header.White)}–${lastName(header.Black)}, ${(header.Date ?? '').slice(0, 4)}`,
        description:
          `From ${label}, around move ${pos.moveNumber}. ` +
          `Place the ${PIECE_NAMES[piece.type]} on one of the highlighted squares — ` +
          `one of them wins, the rest lose.`,
        fen: baseFen,
        player,
        place: [piece.type],
        candidates,
        solution: winner.sq,
        source: {
          white: header.White, black: header.Black, event: header.Event,
          year: (header.Date ?? '').slice(0, 4), moveNumber: pos.moveNumber,
          removedFrom: origin,
          evals: { win: winner.cp, losses: losers.map((l) => l.cp) },
        },
      });
      console.error(
        `  ✓ puzzle: remove ${piece.type.toUpperCase()} from ${origin} @ move ${pos.moveNumber} — ` +
        `win ${winner.sq} (+${(winner.cp / 100).toFixed(1)}), ` +
        `losses ${losers.map((l) => `${l.sq} (${(l.cp / 100).toFixed(1)})`).join(', ')}`,
      );
      break; // at most one puzzle per sampled position, for variety
    }
  }
}

const banner = '// Generated by scripts/generate-puzzles.mjs — do not edit by hand.\n';
writeFileSync(OUT_FILE, `${banner}export default ${JSON.stringify(puzzles, null, 2)};\n`);
console.error(`\nWrote ${puzzles.length} puzzles to ${OUT_FILE}`);
process.exit(0);
