// The puzzle contract: the single source of truth for what a puzzle MEANS.
//
// A puzzle is a self-describing, immediately playable object. The UI, the
// validator, and the line baker all interpret puzzles exclusively through
// this module — none of them knows how a puzzle was generated.
//
//   {
//     id, name, description,
//     fen,          // position with the missing piece(s) removed
//     player,       // 'w' | 'b' — the side the user plays for
//     place,        // piece types to put back, e.g. ['q'] or ['q','r']
//     firstMove,    // 'player' | 'opponent' — who moves after placement
//     placement: {  // optional constraints on where pieces may go
//       allowed?: [squares],   // if present, ONLY these squares
//       blocked?: [squares],   // if present, these squares are refused
//     },
//     solutions?,   // winning placements as signatures (see signature());
//                   // absent = outcome unknown (no reveal, no verdicts)
//     lines?,       // { signature: {m: 'uci uci …', e: 'cp cp …'} } —
//                   // precomputed playouts; absent entries run live engines
//     meta,         // provenance: { batch, generator, source, … } — never
//                   // used for game logic
//   }

import { Chess, validateFen } from 'chess.js';
import { fenToMap, buildFen, flipTurn, rankOf } from './fen.js';

export const opposite = (color) => (color === 'w' ? 'b' : 'w');

/** The side to move once all pieces are placed. */
export function turnFor(puzzle) {
  return puzzle.firstMove === 'opponent' ? opposite(puzzle.player) : puzzle.player;
}

/**
 * Canonical key for a set of placements, e.g. 'q@e4' or 'n@f6+q@d1'.
 * @param {{type: string, square: string}[]} placements
 */
export function signature(placements) {
  return placements
    .map((p) => `${p.type}@${p.square}`)
    .sort()
    .join('+');
}

/** Inverse of signature(): 'q@e4+r@d1' → [{type, square}, …]. */
export function parseSignature(sig) {
  return sig.split('+').map((part) => {
    const [type, square] = part.split('@');
    return { type, square };
  });
}

/** Full FEN for the constructed position. */
export function startFen(puzzle, placements) {
  const map = fenToMap(puzzle.fen);
  for (const p of placements) {
    map[p.square] = { type: p.type, color: puzzle.player };
  }
  return buildFen(map, turnFor(puzzle));
}

/**
 * Per-square placement rule check (constraints the player sees immediately).
 * Returns an error message or null. `occupied` is the current board map.
 */
export function placementError(puzzle, square, pieceType, occupied) {
  if (puzzle.placement?.allowed && !puzzle.placement.allowed.includes(square)) {
    return 'This puzzle only allows the highlighted squares.';
  }
  if (puzzle.placement?.blocked?.includes(square)) {
    return 'That square is blocked — it wins too obviously. Find the hidden winning square.';
  }
  if (occupied[square]) {
    return 'That square is occupied — pick an empty one.';
  }
  if (pieceType === 'p' && (rankOf(square) === 1 || rankOf(square) === 8)) {
    return 'Pawns can’t stand on the first or last rank.';
  }
  return null;
}

/**
 * Whole-position legality check for a fully placed puzzle.
 * Returns an error message or null.
 */
export function startPositionError(puzzle, placements) {
  const fen = startFen(puzzle, placements);
  if (!validateFen(fen).ok) return 'That position is not legal chess.';
  const flipped = new Chess(flipTurn(fen));
  if (flipped.isCheck()) {
    // The side NOT to move may not start in check. With the player to move
    // that means "don't place a piece giving check"; with the opponent to
    // move it can only mean the player put their own king in check.
    return turnFor(puzzle) === puzzle.player
      ? 'You can’t place a piece that gives immediate check — the engines need a legal starting position.'
      : 'Your king can’t be placed into check — pick a safer square.';
  }
  if (new Chess(fen).isGameOver()) {
    return 'That position is already over before a move is played.';
  }
  return null;
}

/** Machine-facing variant of startPositionError (no messages). */
export function isLegalStart(fen) {
  if (!validateFen(fen).ok) return false;
  const flipped = flipTurn(fen);
  if (!validateFen(flipped).ok) return false;
  if (new Chess(flipped).isCheck()) return false;
  return !new Chess(fen).isGameOver();
}

/** 'win' | 'loss' | null (null = puzzle carries no verdicts). */
export function expectedVerdict(puzzle, placements) {
  if (!puzzle.solutions) return null;
  return puzzle.solutions.includes(signature(placements)) ? 'win' : 'loss';
}

/** The precomputed playout for these placements, if the puzzle ships one. */
export function lineFor(puzzle, placements) {
  return puzzle.lines?.[signature(placements)] ?? null;
}

/**
 * All squares where `pieceType` may legally be placed (single-piece helper
 * for the validator and the line baker).
 */
export function placeableSquares(puzzle, pieceType = puzzle.place[0]) {
  const map = fenToMap(puzzle.fen);
  const squares = [];
  for (let rank = 1; rank <= 8; rank++) {
    for (const file of 'abcdefgh') {
      const square = file + rank;
      if (placementError(puzzle, square, pieceType, map)) continue;
      if (!isLegalStart(startFen(puzzle, [{ type: pieceType, square }]))) continue;
      squares.push(square);
    }
  }
  return squares;
}

/**
 * If the allowed squares fill a rectangular zone of the board (counting
 * occupied squares inside the rectangle as part of it — generators list
 * only the EMPTY squares of a sector), returns its corners
 * {from, to} (bottom-left, top-right). Degenerate 1-wide strips and
 * scattered candidate sets return null, so they keep per-square markers.
 */
export function allowedZone(puzzle) {
  const allowed = puzzle.placement?.allowed;
  if (!allowed || allowed.length < 2) return null;
  const map = fenToMap(puzzle.fen);
  const files = allowed.map((sq) => sq.charCodeAt(0) - 97);
  const ranks = allowed.map(rankOf);
  const f0 = Math.min(...files); const f1 = Math.max(...files);
  const r0 = Math.min(...ranks); const r1 = Math.max(...ranks);
  if (f1 - f0 < 1 || r1 - r0 < 1) return null;
  for (let f = f0; f <= f1; f++) {
    for (let r = r0; r <= r1; r++) {
      const sq = String.fromCharCode(97 + f) + r;
      if (!allowed.includes(sq) && !map[sq]) return null; // hole in the zone
    }
  }
  return { from: String.fromCharCode(97 + f0) + r0, to: String.fromCharCode(97 + f1) + r1 };
}

/** Human-readable rule chips for the UI, derived purely from the contract. */
export function ruleChips(puzzle) {
  const chips = [];
  if (puzzle.place.length > 1) chips.push(`${puzzle.place.length} pieces to place`);
  chips.push(puzzle.firstMove === 'opponent' ? 'opponent moves first' : 'you move first');
  if (puzzle.placement?.allowed) chips.push(`choose from ${puzzle.placement.allowed.length} squares`);
  if (puzzle.placement?.blocked) chips.push(`${puzzle.placement.blocked.length} squares blocked`);
  if (puzzle.solutions) {
    chips.push(puzzle.solutions.length === 1 ? '1 winning placement' : `${puzzle.solutions.length} winning placements`);
  }
  return chips;
}
