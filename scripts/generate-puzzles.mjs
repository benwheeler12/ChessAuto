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
// Prototype 2 (open placement): squares whose shallow eval is at least
// EXCLUDE_VERIFY_CP get a deep look, and anything confirmed >= EXCLUDE_CP is
// blocked so that only the chosen solution square wins.
const EXCLUDE_VERIFY_CP = 50;
const EXCLUDE_CP = 150;
const MAX_SHALLOW_WINNERS = 6; // more than this = placement isn't precise/sharp
const ORIGIN_EVAL_LIMIT = 700; // skip positions that were already blowouts
const FIRST_PLY = 16; // skip the opening
const LAST_PLY_MARGIN = 6; // skip the very end of the game
const PLY_STEP = 3;
// Piece-removal priority rotates per sampled position so the output mixes
// heavy pieces with minors, pawns, and even the king (king puzzles only work
// in opponent-moves-first mode, where the placement FENs are fully legal).
const PIECE_VARIANTS = [
  ['q', 'r', 'n', 'b', 'p', 'k'],
  ['k', 'p', 'n', 'b', 'q', 'r'],
  ['n', 'b', 'p', 'q', 'r', 'k'],
];
const PIECE_NAMES = { q: 'queen', r: 'rook', b: 'bishop', n: 'knight', p: 'pawn', k: 'king' };
const MAX_P4_SOLUTIONS = 2; // prototype 4 allows at most this many winning squares

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

/** Same legality rule the game enforces: valid FEN and the side NOT to move not in check. */
function isLegalStart(fen) {
  if (!validateFen(fen).ok) return false;
  const turn = fen.split(' ')[1];
  const flipped = fen.replace(` ${turn} `, ` ${turn === 'w' ? 'b' : 'w'} `);
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
  for (const [posIdx, pos] of positions.entries()) {
    if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

    const player = pos.fen.split(' ')[1];
    const map = fenToMap(pos.fen);

    // Skip positions that were already completely one-sided in the source game.
    const originCp = await engine.evaluate(pos.fen, SHALLOW_MS);
    if (Math.abs(originCp) > ORIGIN_EVAL_LIMIT) continue;

    // Candidate pieces to remove: up to three of distinct type, priority
    // rotating per position so minors/pawns/kings get their turn. Among
    // same-type pawns prefer the most advanced one.
    const prio = PIECE_VARIANTS[posIdx % PIECE_VARIANTS.length];
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
    const removable = [];
    const triedTypes = new Set();
    for (const entry of sorted) {
      if (triedTypes.has(entry[1].type)) continue;
      triedTypes.add(entry[1].type);
      removable.push(entry);
      if (removable.length === 3) break;
    }

    for (const [origin, piece] of removable) {
      if (puzzles.length >= MAX_PUZZLES || fromThisGame >= PER_GAME) break;

      const baseMap = { ...map };
      delete baseMap[origin];
      const key = `${mapToFen(baseMap, player)}|${piece.type}`;
      if (seen.has(key)) continue;

      /**
       * Scan every legal placement square with `turn` to move and classify it
       * from the player's perspective. Returns null unless the scan is sharp:
       * few squares win, one deep-verifies as completely winning, and every
       * other (near-)winner is captured in an exclusion list.
       */
      const scanPlacements = async (turn) => {
        const scans = [];
        for (const sq of ALL_SQUARES) {
          if (baseMap[sq]) continue;
          const fen = mapToFen({ ...baseMap, [sq]: piece }, turn);
          if (!isLegalStart(fen)) continue;
          const cpSide = await engine.evaluate(fen, SHALLOW_MS);
          const cp = turn === player ? cpSide : -cpSide;
          scans.push({ sq, fen, cp });
        }
        const shallowWinners = scans.filter((s) => s.cp >= SHALLOW_WIN_CP).sort((a, b) => b.cp - a.cp);
        if (!shallowWinners.length || shallowWinners.length > MAX_SHALLOW_WINNERS) return null;

        const deepBySq = new Map();
        const deepEval = async (cand) => {
          if (!deepBySq.has(cand.sq)) {
            const deepSide = await engine.evaluate(cand.fen, DEEP_MS);
            deepBySq.set(cand.sq, turn === player ? deepSide : -deepSide);
          }
          return deepBySq.get(cand.sq);
        };

        let winner = null;
        for (const cand of shallowWinners.slice(0, 3)) {
          const deep = await deepEval(cand);
          if (deep >= WIN_CP) { winner = { ...cand, cp: deep }; break; }
        }
        if (!winner) return null;

        // Deep-verify every square shallow search liked at all.
        for (const cand of scans) {
          if (cand.cp >= EXCLUDE_VERIFY_CP) await deepEval(cand);
        }
        // All squares that (nearly) win — the pool prototypes 2/3 block and
        // prototype 4 counts as "solutions".
        const looseWins = [...deepBySq.entries()]
          .filter(([, deep]) => deep >= EXCLUDE_CP)
          .map(([sq]) => sq)
          .sort();
        const excluded = looseWins.filter((sq) => sq !== winner.sq);
        return { scans, winner, excluded, looseWins };
      };

      // Player-to-move analysis (prototypes 1 & 2). The base position must
      // be legal with the player to move (never true for king removal).
      const opponent = player === 'w' ? 'b' : 'w';
      let own = null;
      if (isLegalStart(mapToFen(baseMap, player))) {
        own = await scanPlacements(player);
      }

      // Prototype 1 additionally needs two verified-losing decoy squares.
      let losers = [];
      if (own) {
        const ranked = own.scans
          .filter((s) => s.cp <= SHALLOW_LOSS_CP)
          .sort((a, b) => (b.cp - a.cp) || (squareDistance(a.sq, own.winner.sq) - squareDistance(b.sq, own.winner.sq)));
        for (const cand of ranked) {
          if (losers.length >= 2) break;
          const deep = await engine.evaluate(cand.fen, DEEP_MS);
          if (deep <= LOSS_CP) losers.push({ ...cand, cp: deep });
        }
        if (losers.length < 2) own = null; // without decoys we drop P1/P2 data
      }

      // Opponent-to-move analysis (prototypes 3 & 4): the reply comes first,
      // so instant-capture placements no longer work. King puzzles have no
      // legal base FEN (a side without a king), but every placement FEN is
      // fully legal, which is all these modes need.
      const baseOppLegal = isLegalStart(mapToFen(baseMap, opponent));
      let opp = null;
      if (baseOppLegal || piece.type === 'k') {
        opp = await scanPlacements(opponent);
      }

      if (!own && !opp) continue;

      const lastName = (s) => (s ?? '?').split(',')[0].trim();
      seen.add(key);
      fromThisGame++;
      const puzzle = {
        id: `gm-${puzzles.length + 1}`,
        name: `${lastName(header.White)}–${lastName(header.Black)}, ${(header.Date ?? '').slice(0, 4)}`,
        description: `From ${label}, around move ${pos.moveNumber}. Missing piece: a ${PIECE_NAMES[piece.type]}.`,
        fen: mapToFen(baseMap, player),
        player,
        place: [piece.type],
        source: {
          white: header.White, black: header.Black, event: header.Event,
          year: (header.Date ?? '').slice(0, 4), moveNumber: pos.moveNumber,
          removedFrom: origin,
        },
      };
      if (own) {
        puzzle.candidates = [own.winner.sq, ...losers.map((l) => l.sq)].sort();
        puzzle.excluded = own.excluded;
        puzzle.solution = own.winner.sq;
        puzzle.source.evals = { win: own.winner.cp, losses: losers.map((l) => l.cp) };
      }
      if (opp && baseOppLegal) {
        puzzle.p3 = { excluded: opp.excluded, solution: opp.winner.sq, winCp: opp.winner.cp };
      }
      // Prototype 4: no blocked squares, so the puzzle only qualifies when
      // very few squares win at all.
      if (opp && opp.looseWins.length <= MAX_P4_SOLUTIONS) {
        puzzle.p4 = { solutions: opp.looseWins, winCp: opp.winner.cp };
      }
      if (!puzzle.candidates && !puzzle.p3 && !puzzle.p4) {
        seen.delete(key);
        fromThisGame--;
        continue; // qualified for nothing after all
      }
      puzzles.push(puzzle);
      console.error(
        `  ✓ puzzle: remove ${piece.type.toUpperCase()} from ${origin} @ move ${pos.moveNumber}` +
        (puzzle.candidates
          ? ` — P1/P2 win ${own.winner.sq} (+${(own.winner.cp / 100).toFixed(1)}), ` +
            `losses ${losers.map((l) => `${l.sq} (${(l.cp / 100).toFixed(1)})`).join(', ')}, ` +
            `excluded [${own.excluded.join(' ')}]`
          : '') +
        (puzzle.p3
          ? ` — P3 win ${opp.winner.sq} (+${(opp.winner.cp / 100).toFixed(1)}), excluded [${opp.excluded.join(' ')}]`
          : '') +
        (puzzle.p4
          ? ` — P4 solutions [${puzzle.p4.solutions.join(' ')}]`
          : ''),
      );
      break; // at most one puzzle per sampled position, for variety
    }
  }
}

const banner = '// Generated by scripts/generate-puzzles.mjs — do not edit by hand.\n';
writeFileSync(OUT_FILE, `${banner}export default ${JSON.stringify(puzzles, null, 2)};\n`);
console.error(`\nWrote ${puzzles.length} puzzles to ${OUT_FILE}`);
process.exit(0);
