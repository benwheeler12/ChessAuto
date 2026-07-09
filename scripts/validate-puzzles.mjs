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
  if (!puzzle.place?.length) fail(puzzle, 'no pieces to place');

  // King-placement puzzles have a kingless base FEN, which chess.js can't
  // load — validate their structure by hand, everything else normally.
  const placesKing = puzzle.place?.includes('k');
  let game = null;
  if (placesKing) {
    const map = fenToMap(puzzle.fen);
    const kings = Object.values(map).filter((p) => p.type === 'k');
    if (kings.length !== 1 || kings[0].color === puzzle.player) {
      fail(puzzle, 'king puzzle must be missing exactly the player’s king');
    }
    if (!puzzle.p4) fail(puzzle, 'king puzzles only work in prototype 4');
  } else {
    const check = validateFen(puzzle.fen);
    if (!check.ok) { fail(puzzle, `invalid FEN: ${check.error}`); continue; }
    game = new Chess(puzzle.fen);
    if (game.turn() !== puzzle.player) fail(puzzle, 'it is not the player’s move');
  }

  // Player-to-move modes (P1/P2/classics): the opponent may not start in check.
  if (puzzle.candidates || puzzle.excluded || !puzzle.source) {
    const flipped = flipTurn(puzzle.fen);
    if (validateFen(flipped).ok && new Chess(flipped).isCheck()) {
      fail(puzzle, 'opponent starts in check');
    }
  }
  // P3 flips the turn, so there the PLAYER may not start in check.
  if (puzzle.p3 && new Chess(puzzle.fen).isCheck()) {
    fail(puzzle, 'P3: player would start in check');
  }

  // Prototype 4 data: 1-2 winning squares, all empty, opponent to move first.
  if (puzzle.p4) {
    const map = fenToMap(puzzle.fen);
    const { solutions } = puzzle.p4;
    if (!solutions?.length || solutions.length > 2) {
      fail(puzzle, `P4: ${solutions?.length ?? 0} solutions (want 1-2)`);
    }
    if (new Set(solutions).size !== solutions.length) fail(puzzle, 'P4: duplicate solutions');
    const opponent = puzzle.player === 'w' ? 'b' : 'w';
    for (const sq of solutions ?? []) {
      if (!/^[a-h][1-8]$/.test(sq)) { fail(puzzle, `P4: bad solution square "${sq}"`); continue; }
      if (map[sq]) { fail(puzzle, `P4: solution square ${sq} is occupied`); continue; }
      const placedFen = buildFen(
        { ...map, [sq]: { type: puzzle.place[0], color: puzzle.player } },
        opponent,
      );
      if (!validateFen(placedFen).ok) fail(puzzle, `P4: placement on ${sq} is not a legal position`);
      else if (new Chess(flipTurn(placedFen)).isCheck()) {
        fail(puzzle, `P4: placement on ${sq} leaves the player in check`);
      }
    }
  }

  // Prototype 2/3 data: blocked squares must be sane and never the solution
  const exclusionSets = [];
  if (puzzle.excluded) exclusionSets.push({ excluded: puzzle.excluded, solution: puzzle.solution, tag: 'P2' });
  if (puzzle.p3) exclusionSets.push({ excluded: puzzle.p3.excluded, solution: puzzle.p3.solution, tag: 'P3' });
  for (const { excluded, solution, tag } of exclusionSets) {
    const map = fenToMap(puzzle.fen);
    if (!/^[a-h][1-8]$/.test(solution ?? '')) fail(puzzle, `${tag}: bad solution "${solution}"`);
    else if (map[solution]) fail(puzzle, `${tag}: solution square ${solution} is occupied`);
    if (excluded.includes(solution)) fail(puzzle, `${tag}: solution square is excluded`);
    if (new Set(excluded).size !== excluded.length) fail(puzzle, `${tag}: duplicate excluded squares`);
    for (const sq of excluded) {
      if (!/^[a-h][1-8]$/.test(sq)) fail(puzzle, `${tag}: bad excluded square "${sq}"`);
      else if (map[sq]) fail(puzzle, `${tag}: excluded square ${sq} is occupied`);
    }
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
  } else if (!puzzle.source) {
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

// Precomputed playout lines: every line must replay legally, reach a
// terminal position, and agree with the square's verdict.
let lineCount = 0;
for (const puzzle of PUZZLES) {
  if (!puzzle.lines) continue;
  for (const [mode, bySquare] of Object.entries(puzzle.lines)) {
    const turn = mode === 'own' ? puzzle.player : puzzle.player === 'w' ? 'b' : 'w';
    const winners = mode === 'own'
      ? [puzzle.solution].filter(Boolean)
      : puzzle.p4 ? puzzle.p4.solutions : [puzzle.p3?.solution].filter(Boolean);
    for (const [sq, line] of Object.entries(bySquare)) {
      lineCount++;
      const map = fenToMap(puzzle.fen);
      map[sq] = { type: puzzle.place[0], color: puzzle.player };
      const g = new Chess(buildFen(map, turn));
      const moves = line.m.split(' ');
      if (line.e.split(' ').length !== moves.length) {
        fail(puzzle, `line ${mode}/${sq}: evals/moves length mismatch`);
      }
      try {
        for (const uci of moves) {
          g.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
        }
      } catch (err) {
        fail(puzzle, `line ${mode}/${sq}: illegal move in stored line (${err.message.slice(0, 60)})`);
        continue;
      }
      if (!g.isGameOver()) { fail(puzzle, `line ${mode}/${sq}: does not reach a terminal position`); continue; }
      const playerWon = g.isCheckmate() && g.turn() !== puzzle.player;
      const shouldWin = winners.includes(sq);
      if (playerWon !== shouldWin) {
        fail(puzzle, `line ${mode}/${sq}: verdict mismatch (playerWon=${playerWon}, expected ${shouldWin ? 'win' : 'not-win'})`);
      }
    }
  }
}

if (failures) {
  console.error(`\n${failures} puzzle problem(s) found.`);
  process.exit(1);
}
console.log(`✓ All ${PUZZLES.length} puzzles are valid (${lineCount} playout lines verified).`);
