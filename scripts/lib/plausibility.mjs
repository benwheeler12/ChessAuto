// Pattern-recognition plausibility: how "sensible-looking" is an
// arrangement of placed pieces to a human chess player? Players pattern-
// match small structures they've seen in thousands of games — supported
// pawn chains, advanced knights on defended outposts, bishops tucked into
// pawn structure, queen/rook batteries, rooks on open files — and reach
// for the arrangement that triggers the most of them. A puzzle whose
// WINNING arrangement is also its most plausible-looking one gets solved
// by instinct instead of calculation; the non-obvious qualifier in
// generate-spots.mjs uses this score to reject those.
//
// Engine-free static analysis. @cost ~1ms per arrangement (a handful of
// attackers() calls per placed piece).

import { Chess } from 'chess.js';

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = 'abcdefgh';

/**
 * Plausibility score for one arrangement: `placements` ([{type, square}])
 * of the player's pieces onto a base position. Higher = more "sensible
 * looking". Only the placed pieces are scored — everything else is common
 * to all arrangements of a puzzle.
 * @param {string} fen the COMPLETE position with the pieces placed
 * @param {{type: string, square: string}[]} placements
 * @param {'w'|'b'} player
 */
export function arrangementPlausibility(fen, placements, player) {
  const game = new Chess(fen);
  const opponent = player === 'w' ? 'b' : 'w';
  const board = {};
  for (const row of game.board()) {
    for (const cell of row) if (cell) board[cell.square] = cell;
  }
  const relRank = (sq) => (player === 'w' ? Number(sq[1]) : 9 - Number(sq[1]));
  const fileIdx = (sq) => sq.charCodeAt(0) - 97;

  let score = 0;
  for (const { type, square } of placements) {
    const guards = game.attackers(square, player);
    const pawnGuard = guards.some((g) => board[g]?.type === 'p');
    const attackers = game.attackers(square, opponent);

    // Universal cues: a defended piece looks placed "correctly"; a piece
    // hanging to a cheaper attacker looks like a blunder.
    if (guards.length) score += 2;
    const cheapest = Math.min(...attackers.map((a) => VALUES[board[a]?.type] ?? 9), 9);
    if (attackers.length && cheapest < VALUES[type]) score -= 3;

    switch (type) {
      case 'p':
        // Pawns at the tip of a supported chain read as textbook structure.
        if (pawnGuard) score += 3;
        if (relRank(square) >= 5) score += 1;
        break;
      case 'n':
        // The forward, central, pawn-supported knight is THE outpost cliché.
        if (relRank(square) >= 4) score += 2;
        if (fileIdx(square) >= 2 && fileIdx(square) <= 5) score += 1;
        if (pawnGuard) score += 2;
        break;
      case 'b':
        // Bishops tucked into defended pawn structure or on a long diagonal.
        if (pawnGuard) score += 2;
        if (['a1', 'h1', 'a8', 'h8', 'b2', 'g2', 'b7', 'g7', 'd4', 'e4', 'd5', 'e5']
          .includes(square)) score += 1;
        break;
      case 'r': {
        // Open/semi-open file, or the 7th rank.
        let ownPawns = 0;
        let anyPawns = 0;
        for (let r = 1; r <= 8; r++) {
          const p = board[FILES[fileIdx(square)] + r];
          if (p?.type === 'p') { anyPawns++; if (p.color === player) ownPawns++; }
        }
        if (!anyPawns) score += 2;
        else if (!ownPawns) score += 1;
        if (relRank(square) === 7) score += 2;
        break;
      }
      case 'q': {
        // Batteries with a rook (queen in front or behind on file/rank)
        // and queens near the enemy king look natural and aggressive.
        for (const [sq, piece] of Object.entries(board)) {
          if (piece.color !== player || piece.type !== 'r') continue;
          if (sq[0] === square[0] || sq[1] === square[1]) { score += 2; break; }
        }
        const ek = Object.keys(board).find((sq) => board[sq].type === 'k' && board[sq].color === opponent);
        if (ek && Math.max(Math.abs(fileIdx(ek) - fileIdx(square)),
          Math.abs(Number(ek[1]) - Number(square[1]))) <= 2) score += 1;
        break;
      }
      case 'k': {
        // Kings shielded by pawns look right.
        let shield = 0;
        for (const df of [-1, 0, 1]) {
          const f = fileIdx(square) + df;
          if (f < 0 || f > 7) continue;
          const ahead = FILES[f] + (Number(square[1]) + (player === 'w' ? 1 : -1));
          if (board[ahead]?.type === 'p' && board[ahead].color === player) shield++;
        }
        score += shield;
        break;
      }
      default:
        break;
    }
  }
  return score;
}

/**
 * How the arrangement `sig` ranks by plausibility. `top` is the best score
 * among the OTHER arrangements; the winner only counts as hidden when its
 * score is STRICTLY below that (a tie means instinct still finds it —
 * calibrated on b009 playtest verdicts, where the two "easy, sensible
 * squares" puzzles tied their top score and the "challenging and great"
 * one trailed it by 2). Returns {rank, score, top, hidden}.
 */
export function plausibilityRank(scored, sig) {
  const mine = scored.find((s) => s.sig === sig)?.plausibility ?? -Infinity;
  const others = scored.filter((s) => s.sig !== sig).map((s) => s.plausibility);
  const top = others.length ? Math.max(...others) : -Infinity;
  const rank = others.filter((p) => p >= mine).length;
  return { rank, score: mine, top, hidden: mine < top };
}
