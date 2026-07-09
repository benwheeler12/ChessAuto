// Sanity-checks every puzzle definition:
//  - the semicomplete FEN is legal and it's the player's move
//  - nobody starts in check
//  - the player can reach a decisive material advantage by placing the pieces
import { Chess, validateFen } from 'chess.js';
import { PUZZLES } from '../src/puzzles.js';

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
  if (game.isCheck()) fail(puzzle, 'player starts in check');

  const flipped = puzzle.fen.replace(` ${puzzle.player} `, ` ${puzzle.player === 'w' ? 'b' : 'w'} `);
  if (validateFen(flipped).ok && new Chess(flipped).isCheck()) {
    fail(puzzle, 'opponent starts in check');
  }

  let material = 0;
  for (const { type, color } of Object.values(game.board()).flat().filter(Boolean)) {
    material += (color === puzzle.player ? 1 : -1) * VALUES[type];
  }
  const placed = puzzle.place.reduce((sum, t) => sum + VALUES[t], 0);
  if (material + placed < 3) {
    fail(puzzle, `only ${material + placed} points of material advantage after placement — not clearly winnable`);
  }

  if (!puzzle.place.length) fail(puzzle, 'no pieces to place');
  if (puzzle.moveCap < 20 || puzzle.moveCap > 30) fail(puzzle, `moveCap ${puzzle.moveCap} outside 20–30`);
}

if (failures) {
  console.error(`\n${failures} puzzle problem(s) found.`);
  process.exit(1);
}
console.log(`✓ All ${PUZZLES.length} puzzles are valid.`);
