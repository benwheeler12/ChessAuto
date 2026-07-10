// Validates every puzzle batch against the puzzle contract
// (src/puzzle-contract.js). Batch files are discovered from src/puzzles/
// directly (Node can't use Vite's import.meta.glob).
//
// Checks per puzzle:
//  - contract shape: required fields, enums, unique ids
//  - placement constraints reference valid, empty, disjoint squares
//  - every solution is a legal, allowed placement
//  - every stored line replays legally to a terminal position and agrees
//    with the puzzle's verdict for that placement (when verdicts exist)
//  - free-placement puzzles without verdicts get the material sanity check

import { Chess } from 'chess.js';
import { readBatches } from './lib/batches.mjs';
import { fenToMap } from '../src/fen.js';
import {
  turnFor, signature, parseSignature, startFen, placementError,
  isLegalStart, placeableSquares,
} from '../src/puzzle-contract.js';

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const PIECE_TYPES = ['p', 'n', 'b', 'r', 'q', 'k'];
let failures = 0;

function fail(puzzle, msg) {
  failures++;
  console.error(`✗ ${puzzle.id ?? '(no id)'}: ${msg}`);
}

const batches = readBatches();
const PUZZLES = batches.flatMap((b) => b.puzzles);

const seenIds = new Set();
const validSquare = (sq) => /^[a-h][1-8]$/.test(sq);
let lineCount = 0;

for (const puzzle of PUZZLES) {
  // ---- shape ----
  if (!puzzle.id || seenIds.has(puzzle.id)) fail(puzzle, 'missing or duplicate id');
  seenIds.add(puzzle.id);
  if (!puzzle.name) fail(puzzle, 'missing name');
  if (puzzle.player !== 'w' && puzzle.player !== 'b') fail(puzzle, `bad player "${puzzle.player}"`);
  if (!['player', 'opponent'].includes(puzzle.firstMove)) fail(puzzle, `bad firstMove "${puzzle.firstMove}"`);
  if (!Array.isArray(puzzle.place) || !puzzle.place.length || puzzle.place.some((t) => !PIECE_TYPES.includes(t))) {
    fail(puzzle, 'bad place list');
    continue;
  }
  if (!puzzle.meta?.batch?.id) fail(puzzle, 'missing meta.batch');

  // ---- board ----
  const map = fenToMap(puzzle.fen);
  const kings = Object.values(map).filter((p) => p.type === 'k');
  const placesKing = puzzle.place.includes('k');
  const expectedKings = placesKing ? 1 : 2;
  if (kings.length !== expectedKings) fail(puzzle, `expected ${expectedKings} king(s) on the base board, found ${kings.length}`);
  if (placesKing && kings.some((k) => k.color === puzzle.player)) {
    fail(puzzle, 'king puzzle must be missing exactly the player’s king');
  }

  // ---- placement constraints ----
  const allowed = puzzle.placement?.allowed;
  const blocked = puzzle.placement?.blocked;
  for (const [label, list] of [['allowed', allowed], ['blocked', blocked]]) {
    if (!list) continue;
    if (!list.length) fail(puzzle, `empty ${label} list — omit the constraint instead`);
    if (new Set(list).size !== list.length) fail(puzzle, `duplicate ${label} squares`);
    for (const sq of list) {
      if (!validSquare(sq)) fail(puzzle, `bad ${label} square "${sq}"`);
      else if (map[sq]) fail(puzzle, `${label} square ${sq} is occupied`);
    }
  }
  if (allowed && blocked && allowed.some((sq) => blocked.includes(sq))) {
    fail(puzzle, 'allowed and blocked overlap');
  }
  if (allowed && allowed.length < 2) fail(puzzle, 'fewer than 2 allowed squares');

  // ---- solutions ----
  if (puzzle.solutions) {
    if (!puzzle.solutions.length) fail(puzzle, 'empty solutions list');
    for (const sig of puzzle.solutions) {
      const parts = parseSignature(sig);
      const types = parts.map((p) => p.type).sort().join('');
      if (types !== [...puzzle.place].sort().join('')) {
        fail(puzzle, `solution "${sig}" doesn't match the place list`);
        continue;
      }
      let bad = false;
      for (const part of parts) {
        if (!validSquare(part.square)) { fail(puzzle, `solution "${sig}" has bad square`); bad = true; break; }
        const err = placementError(puzzle, part.square, part.type, map);
        if (err) { fail(puzzle, `solution "${sig}": ${err}`); bad = true; break; }
      }
      if (!bad && !isLegalStart(startFen(puzzle, parts))) {
        fail(puzzle, `solution "${sig}" is not a legal starting position`);
      }
    }
  } else if (puzzle.place.length >= 1 && !puzzle.lines) {
    // Free-placement puzzle without verdicts: material sanity check.
    let material = 0;
    for (const piece of Object.values(map)) {
      material += (piece.color === puzzle.player ? 1 : -1) * VALUES[piece.type];
    }
    const placedValue = puzzle.place.reduce((sum, t) => sum + VALUES[t], 0);
    if (material + placedValue < 3) {
      fail(puzzle, `only ${material + placedValue} points of material advantage after placement — not clearly winnable`);
    }
  }

  // ---- lines ----
  if (puzzle.lines) {
    // Which placements are actually reachable under the constraints?
    for (const [sig, line] of Object.entries(puzzle.lines)) {
      const parts = parseSignature(sig);
      if (parts.some((p) => placementError(puzzle, p.square, p.type, map))) continue; // inert line
      lineCount++;
      const moves = line.m.split(' ');
      if (line.e.split(' ').length !== moves.length) {
        fail(puzzle, `line ${sig}: evals/moves length mismatch`);
      }
      const g = new Chess(startFen(puzzle, parts));
      try {
        for (const uci of moves) {
          g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        }
      } catch (err) {
        fail(puzzle, `line ${sig}: illegal move (${err.message.slice(0, 60)})`);
        continue;
      }
      if (!g.isGameOver()) { fail(puzzle, `line ${sig}: does not reach a terminal position`); continue; }
      if (puzzle.solutions) {
        const playerWon = g.isCheckmate() && g.turn() !== puzzle.player;
        const shouldWin = puzzle.solutions.includes(sig);
        if (playerWon !== shouldWin) {
          fail(puzzle, `line ${sig}: verdict mismatch (playerWon=${playerWon}, expected ${shouldWin ? 'win' : 'not-win'})`);
        }
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} puzzle problem(s) found.`);
  process.exit(1);
}
console.log(`✓ ${PUZZLES.length} puzzles across ${batches.length} batches are valid (${lineCount} playout lines verified).`);
