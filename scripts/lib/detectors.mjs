// Candidate detectors: pure functions that look at ONE position and return
// board states or regions worth investigating — no engine, no I/O. These
// are the cheap pre-filters that decide what the expensive engine
// qualification (qualify.mjs) gets to see.
//
// COST MODEL: everything here is static analysis in the 10µs–1ms range;
// hotSectors is the priciest (~1ms — one attackers() call per occupied
// square). Combo enumeration is combinatorial but capped by the caller.

import { Chess } from 'chess.js';
import { buildFen } from '../../src/fen.js';
import { isLegalStart, signature } from '../../src/puzzle-contract.js';

const FILES = 'abcdefgh';
export const ALL_SQUARES = [];
for (let r = 1; r <= 8; r++) for (const f of FILES) ALL_SQUARES.push(f + r);

/** The 9 squares of a 3×3 sector anchored at its bottom-left corner. @cost µs */
export function sectorSquares(fileIdx, rank) {
  const squares = [];
  for (let f = fileIdx; f < fileIdx + 3; f++) {
    for (let r = rank; r < rank + 3; r++) squares.push(FILES[f] + r);
  }
  return squares;
}

/**
 * Rank every 3×3 sector of a position by tactical heat: pieces of both
 * colors inside plus occupied squares under enemy attack. Returns the top
 * sectors where the player has minMine..maxMine non-king pieces (the ones a
 * sector puzzle would remove) and the opponent has at least one piece.
 * @param {Record<string, {type,color}>} map board map (fenToMap shape)
 * @param {string} fen the position (for attack computation)
 * @param {'w'|'b'} player
 * @returns {{anchor: string, squares: string[], mine: string[], contacts: number, score: number}[]}
 * @cost ~1ms — one attackers() call per occupied square
 */
export function hotSectors(map, fen, player, { minMine = 2, maxMine = 3, top = 3 } = {}) {
  const game = new Chess(fen);
  const opponent = player === 'w' ? 'b' : 'w';
  const sectors = [];
  for (let f = 0; f <= 5; f++) {
    for (let r = 1; r <= 6; r++) {
      const squares = sectorSquares(f, r);
      const mine = squares.filter((sq) => map[sq]?.color === player && map[sq].type !== 'k');
      const theirs = squares.filter((sq) => map[sq]?.color === opponent);
      if (squares.some((sq) => map[sq]?.type === 'k' && map[sq].color === player)) continue;
      if (mine.length < minMine || mine.length > maxMine || !theirs.length) continue;
      let contacts = 0;
      for (const sq of squares) {
        if (!map[sq]) continue;
        if (game.isAttacked(sq, map[sq].color === 'w' ? 'b' : 'w')) contacts++;
      }
      sectors.push({
        anchor: FILES[f] + r,
        squares,
        mine,
        contacts,
        score: mine.length * 2 + theirs.length + contacts * 2,
      });
    }
  }
  return sectors.sort((a, b) => b.score - a.score).slice(0, top);
}

/**
 * The player's pieces worth trying to remove from a position, ordered by a
 * rotating priority list so batches mix piece types. Pawns are ordered most
 * advanced first. Returns [square, piece] entries, first-of-each-type ahead
 * of duplicates. @cost ~10µs
 */
export function removablePieces(map, player, variant = 0, limit = 6) {
  const PIECE_VARIANTS = [
    ['q', 'r', 'n', 'b', 'p', 'k'],
    ['k', 'p', 'n', 'b', 'q', 'r'],
    ['n', 'b', 'p', 'q', 'r', 'k'],
  ];
  const prio = PIECE_VARIANTS[variant % PIECE_VARIANTS.length];
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
  const firstOfType = [];
  const extras = [];
  const tried = new Set();
  for (const entry of sorted) {
    if (tried.has(entry[1].type)) extras.push(entry);
    else { tried.add(entry[1].type); firstOfType.push(entry); }
  }
  return [...firstOfType, ...extras].slice(0, limit);
}

/**
 * All squares where a piece may be placed onto a base map so that the
 * resulting position (given side to move) is a legal, non-terminated start.
 * @returns {{square: string, fen: string}[]}
 * @cost ~5–15ms — one legality check (two FEN validations) per empty square
 */
export function legalPlacements(baseMap, piece, toMove, squares = ALL_SQUARES) {
  const out = [];
  for (const square of squares) {
    if (baseMap[square]) continue;
    const fen = buildFen({ ...baseMap, [square]: piece }, toMove);
    if (!isLegalStart(fen)) continue;
    out.push({ square, fen });
  }
  return out;
}

/**
 * Every way to place `types` (a multiset of piece types, all one color) onto
 * distinct squares from `empties`, deduplicated by placement signature.
 * Stops growing past `cap` entries so callers can reject explosions cheaply.
 * @returns {Map<string, {type, square}[]>} signature → placements
 * @cost combinatorial: |empties|! / (|empties|−k)! before dedup, capped
 */
export function enumerateCombos(types, empties, cap = 400) {
  const out = new Map();
  const recur = (i, chosen, used) => {
    if (out.size > cap) return;
    if (i === types.length) {
      const placements = chosen.map((c) => ({ ...c }));
      out.set(signature(placements), placements);
      return;
    }
    for (const square of empties) {
      if (used.has(square)) continue;
      chosen.push({ type: types[i], square });
      used.add(square);
      recur(i + 1, chosen, used);
      chosen.pop();
      used.delete(square);
    }
  };
  recur(0, [], new Set());
  return out;
}

/**
 * Clusters of coordinated pieces: groups of `size` non-king pieces of one
 * color connected by defense relations (one piece guards another's square)
 * or direct adjacency. Scored by mutual defenses, enemy contact, and piece-
 * type diversity (distinct types make richer placement assignments).
 * @returns {{squares: string[], types: string[], score: number,
 *            defenses: number}[]} top clusters, best first
 * @cost ~1ms — one attackers() call per piece plus subset enumeration
 */
export function defenseClusters(map, fen, player, { size = 3, top = 3 } = {}) {
  const game = new Chess(fen);
  const opponent = player === 'w' ? 'b' : 'w';
  const squares = Object.keys(map).filter((sq) => map[sq].color === player && map[sq].type !== 'k');
  if (squares.length < size) return [];

  const own = new Set(squares);
  const defense = new Map(squares.map((sq) => [sq, new Set()]));
  const near = new Map(squares.map((sq) => [sq, new Set()]));
  for (const sq of squares) {
    for (const guard of game.attackers(sq, player)) {
      if (!own.has(guard)) continue; // kings and pawns off-map don't cluster
      defense.get(sq).add(guard);
      defense.get(guard).add(sq);
    }
    for (const other of squares) {
      if (other === sq) continue;
      const df = Math.abs(sq.charCodeAt(0) - other.charCodeAt(0));
      const dr = Math.abs(Number(sq[1]) - Number(other[1]));
      if (Math.max(df, dr) <= 1) near.get(sq).add(other);
    }
  }
  const connected = (subset) => {
    const seen = new Set([subset[0]]);
    const stack = [subset[0]];
    while (stack.length) {
      const cur = stack.pop();
      for (const nb of subset) {
        if (seen.has(nb)) continue;
        if (defense.get(cur).has(nb) || near.get(cur).has(nb)) {
          seen.add(nb);
          stack.push(nb);
        }
      }
    }
    return seen.size === subset.length;
  };

  const clusters = [];
  const pick = (start, chosen) => {
    if (chosen.length === size) {
      if (!connected(chosen)) return;
      let defenses = 0;
      let contacts = 0;
      for (let i = 0; i < chosen.length; i++) {
        if (game.isAttacked(chosen[i], opponent)) contacts++;
        for (let j = i + 1; j < chosen.length; j++) {
          if (defense.get(chosen[i]).has(chosen[j])) defenses++;
        }
      }
      const types = chosen.map((sq) => map[sq].type);
      const distinct = new Set(types).size;
      clusters.push({
        squares: [...chosen],
        types,
        defenses,
        score: defenses * 3 + contacts * 2 + distinct * 2,
      });
      return;
    }
    for (let i = start; i < squares.length; i++) {
      chosen.push(squares[i]);
      pick(i + 1, chosen);
      chosen.pop();
    }
  };
  pick(0, []);
  return clusters.sort((a, b) => b.score - a.score).slice(0, top);
}
