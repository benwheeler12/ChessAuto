// Small helpers for manipulating the board portion of a FEN string.

const FILES = 'abcdefgh';

/** Parse the piece-placement field of a FEN into a { square: {type, color} } map. */
export function fenToMap(fen) {
  const board = fen.split(' ')[0];
  const map = {};
  const rows = board.split('/');
  for (let r = 0; r < 8; r++) {
    let file = 0;
    for (const ch of rows[r]) {
      if (/\d/.test(ch)) {
        file += Number(ch);
      } else {
        const square = FILES[file] + (8 - r);
        map[square] = {
          type: ch.toLowerCase(),
          color: ch === ch.toUpperCase() ? 'w' : 'b',
        };
        file++;
      }
    }
  }
  return map;
}

/** Build the piece-placement field of a FEN from a { square: {type, color} } map. */
export function mapToFenBoard(map) {
  const rows = [];
  for (let r = 8; r >= 1; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const piece = map[FILES[f] + r];
      if (piece) {
        if (empty) { row += empty; empty = 0; }
        row += piece.color === 'w' ? piece.type.toUpperCase() : piece.type;
      } else {
        empty++;
      }
    }
    if (empty) row += empty;
    rows.push(row);
  }
  return rows.join('/');
}

/** Full FEN for a constructed position: given board map and side to move. */
export function buildFen(map, turn) {
  return `${mapToFenBoard(map)} ${turn} - - 0 1`;
}

/** Return the same FEN with the side to move flipped (used for legality checks). */
export function flipTurn(fen) {
  const parts = fen.split(' ');
  parts[1] = parts[1] === 'w' ? 'b' : 'w';
  parts[3] = '-'; // en passant square is meaningless after flipping
  return parts.join(' ');
}

export const SQUARES = (() => {
  const out = [];
  for (let r = 8; r >= 1; r--) {
    for (let f = 0; f < 8; f++) out.push(FILES[f] + r);
  }
  return out;
})();

export function rankOf(square) {
  return Number(square[1]);
}
