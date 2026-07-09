// Sanity-checks every puzzle definition:
//  - the semicomplete FEN is legal and it's the player's move
//  - the opponent doesn't start in check
//  - free-placement puzzles: decisive material advantage is reachable
//  - candidate puzzles: 2-3 unique empty squares, the solution among them,
//    and every candidate placement produces a legal starting position
import { Chess, validateFen } from 'chess.js';
import { PUZZLES } from '../src/puzzles.js';
import { fenToMap, buildFen, flipTurn, rankOf } from '../src/fen.js';

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
let failures = 0;

function fail(puzzle, msg) {
  failures++;
  console.error(`✗ ${puzzle.id}: ${msg}`);
}

for (const puzzle of PUZZLES) {
  const check = validateFen(puzzle.fen);
  if (!check.ok) { fail(puzzle, `invalid FEN: ${check.error}`); continue; }

  const game = new Chess(puzzle.fen);
  if (game.turn() !== puzzle.player) fail(puzzle, 'it is not the player’s move');
  if (!puzzle.place?.length) fail(puzzle, 'no pieces to place');

  const flipped = flipTurn(puzzle.fen);
  if (validateFen(flipped).ok && new Chess(flipped).isCheck()) {
    fail(puzzle, 'opponent starts in check');
  }

  if (puzzle.candidates) {
    // Generated candidate-constrained puzzle
    if (puzzle.place.length !== 1) fail(puzzle, 'candidate puzzles must place exactly one piece');
    if (puzzle.candidates.length < 2 || puzzle.candidates.length > 3) {
      fail(puzzle, `${puzzle.candidates.length} candidates (want 2-3)`);
    }
    if (new Set(puzzle.candidates).size !== puzzle.candidates.length) {
      fail(puzzle, 'duplicate candidate squares');
    }
    if (!puzzle.candidates.includes(puzzle.solution)) {
      fail(puzzle, 'solution square is not among the candidates');
    }
    const map = fenToMap(puzzle.fen);
    for (const sq of puzzle.candidates) {
      if (!/^[a-h][1-8]$/.test(sq)) { fail(puzzle, `bad square "${sq}"`); continue; }
      if (map[sq]) { fail(puzzle, `candidate ${sq} is occupied`); continue; }
      if (puzzle.place[0] === 'p' && (rankOf(sq) === 1 || rankOf(sq) === 8)) {
        fail(puzzle, `pawn candidate on back rank ${sq}`);
        continue;
      }
      const placedFen = buildFen(
        { ...map, [sq]: { type: puzzle.place[0], color: puzzle.player } },
        puzzle.player,
      );
      if (!validateFen(placedFen).ok) { fail(puzzle, `placement on ${sq} is not a legal position`); continue; }
      if (new Chess(flipTurn(placedFen)).isCheck()) {
        fail(puzzle, `placement on ${sq} gives immediate check`);
      }
    }
  } else {
    // Hand-written free-placement puzzle
    if (game.isCheck()) fail(puzzle, 'player starts in check');
    let material = 0;
    for (const { type, color } of Object.values(game.board()).flat().filter(Boolean)) {
      material += (color === puzzle.player ? 1 : -1) * VALUES[type];
    }
    const placed = puzzle.place.reduce((sum, t) => sum + VALUES[t], 0);
    if (material + placed < 3) {
      fail(puzzle, `only ${material + placed} points of material advantage after placement — not clearly winnable`);
    }
  }
}

if (failures) {
  console.error(`\n${failures} puzzle problem(s) found.`);
  process.exit(1);
}
console.log(`✓ All ${PUZZLES.length} puzzles are valid.`);
