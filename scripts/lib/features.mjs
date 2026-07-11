// Static position features (the "T0" set): pure, stateless functions over a
// chess.js Chess instance. Each returns a small record; allFeatures() fuses
// them into the flat row shape consumed by ranking and reporting.
//
// COST MODEL — measured on this machine with `npm run bench` (see README):
// every function here is engine-free and runs in MICROSECONDS per position.
// The dominant costs are chess.js attackers() and moves() calls; functions
// list their approximate share. Fusing via allFeatures() costs ~2× a single
// hand-fused pass (each function re-derives the board) — still ~5ms/position
// worst case, which is noise next to any engine call (80–700ms).
//
// Perspective convention: *W/*B suffixes are absolute colors; callers doing
// player-relative math flip at their end.

import { Chess, validateFen } from 'chess.js';
import { flipTurn } from '../../src/fen.js';

export const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = 'abcdefgh';
const DIRS = {
  rook: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  bishop: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
};

/** Shared board accessors for one position. @cost ~10µs */
function boardCtx(game) {
  const board = game.board(); // ranks 8..1
  const pieceAt = (f, r) => (f >= 0 && f < 8 && r >= 1 && r <= 8 ? board[8 - r][f] : undefined);
  return { board, pieceAt, pieces: board.flat().filter(Boolean) };
}

/**
 * Material count per side, difference (white − black), and game phase
 * (total non-pawn material). @cost ~20µs
 */
export function material(game) {
  const { pieces } = boardCtx(game);
  const sum = { w: 0, b: 0 };
  for (const piece of pieces) sum[piece.color] += VALUES[piece.type];
  const phase = sum.w + sum.b - pieces.filter((p) => p.type === 'p').length;
  return { materialW: sum.w, materialB: sum.b, materialDiff: sum.w - sum.b, phase };
}

/**
 * Attack geometry: how many pieces of each side are attacked (tension),
 * total attacker→victim pairs (contacts), and hanging pieces (attacked and
 * undefended, or attacked by something cheaper).
 * @cost ~0.5–1.5ms — one attackers() call per attacked piece, the single
 * most expensive static feature.
 */
export function attacks(game) {
  const { pieceAt, pieces } = boardCtx(game);
  const attacked = { w: 0, b: 0 };
  const hanging = { w: 0, b: 0 };
  let contacts = 0;
  for (const piece of pieces) {
    if (piece.type === 'k') continue;
    const enemy = piece.color === 'w' ? 'b' : 'w';
    const attackers = game.attackers(piece.square, enemy);
    if (!attackers.length) continue;
    attacked[piece.color]++;
    contacts += attackers.length;
    const defenders = game.attackers(piece.square, piece.color);
    const cheapest = Math.min(...attackers.map((sq) => {
      const att = pieceAt(FILES.indexOf(sq[0]), Number(sq[1]));
      return att ? VALUES[att.type] || 99 : 99;
    }));
    if (!defenders.length || cheapest < VALUES[piece.type]) hanging[piece.color]++;
  }
  return {
    tension: attacked.w + attacked.b,
    contacts,
    hangingW: hanging.w,
    hangingB: hanging.b,
    hangingTotal: hanging.w + hanging.b,
  };
}

/** Absolute pins against each king, found by ray-walking. @cost ~50µs */
export function pins(game) {
  const { pieceAt, pieces } = boardCtx(game);
  const found = { w: 0, b: 0 };
  for (const color of ['w', 'b']) {
    const king = pieces.find((p) => p.type === 'k' && p.color === color);
    if (!king) continue;
    const kf = FILES.indexOf(king.square[0]);
    const kr = Number(king.square[1]);
    for (const [kind, dirs] of Object.entries(DIRS)) {
      for (const [df, dr] of dirs) {
        let f = kf + df; let r = kr + dr; let shield = null;
        while (true) {
          const piece = pieceAt(f, r);
          if (piece === undefined) break; // off board
          if (piece) {
            if (!shield) {
              if (piece.color !== color) break;
              shield = piece;
            } else {
              if (piece.color !== color && (piece.type === 'q' || piece.type === (kind === 'rook' ? 'r' : 'b'))) {
                found[color]++;
              }
              break;
            }
          }
          f += df; r += dr;
        }
      }
    }
  }
  return { pinsW: found.w, pinsB: found.b, pinsTotal: found.w + found.b };
}

/**
 * King safety geometry per side: pawn shield in the king's three files,
 * enemy attacks on the king ring, and own-pawn-free files near the king.
 * @cost ~0.3ms — up to 16 attackers() calls (8 ring squares × 2 kings).
 */
export function kingSafety(game) {
  const { pieceAt, pieces } = boardCtx(game);
  const out = {};
  for (const color of ['w', 'b']) {
    const king = pieces.find((p) => p.type === 'k' && p.color === color);
    const enemy = color === 'w' ? 'b' : 'w';
    const kf = FILES.indexOf(king.square[0]);
    const kr = Number(king.square[1]);
    let shield = 0; let ringAttack = 0; let openFiles = 0;
    const forward = color === 'w' ? 1 : -1;
    for (let df = -1; df <= 1; df++) {
      for (const dr of [forward, 2 * forward]) {
        const p = pieceAt(kf + df, kr + dr);
        if (p && p.type === 'p' && p.color === color) { shield++; break; }
      }
      const file = kf + df;
      if (file >= 0 && file < 8) {
        let ownPawn = false;
        for (let r = 1; r <= 8; r++) {
          const p = pieceAt(file, r);
          if (p && p.type === 'p' && p.color === color) { ownPawn = true; break; }
        }
        if (!ownPawn) openFiles++;
      }
      for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const f = kf + df; const r = kr + dr;
        if (f < 0 || f > 7 || r < 1 || r > 8) continue;
        ringAttack += game.attackers(FILES[f] + r, enemy).length;
      }
    }
    out[color] = { shield, ringAttack, openFiles };
  }
  return {
    shieldW: out.w.shield,
    shieldB: out.b.shield,
    ringAttackW: out.w.ringAttack,
    ringAttackB: out.b.ringAttack,
    ringAttackMax: Math.max(out.w.ringAttack, out.b.ringAttack),
    openFilesNearKingW: out.w.openFiles,
    openFilesNearKingB: out.b.openFiles,
  };
}

/** Passed pawns per side and the furthest passer's advance. @cost ~50µs */
export function passedPawns(game) {
  const { pieceAt, pieces } = boardCtx(game);
  const passed = { w: 0, b: 0 };
  let maxPasserAdvance = 0;
  for (const piece of pieces) {
    if (piece.type !== 'p') continue;
    const f = FILES.indexOf(piece.square[0]);
    const r = Number(piece.square[1]);
    const forward = piece.color === 'w' ? 1 : -1;
    let blocked = false;
    for (let df = -1; df <= 1 && !blocked; df++) {
      for (let rr = r + forward; rr >= 2 && rr <= 7 && !blocked; rr += forward) {
        const p = pieceAt(f + df, rr);
        if (p && p.type === 'p' && p.color !== piece.color) blocked = true;
      }
    }
    if (!blocked) {
      passed[piece.color]++;
      const advance = piece.color === 'w' ? r - 2 : 7 - r;
      maxPasserAdvance = Math.max(maxPasserAdvance, advance);
    }
  }
  return { passedW: passed.w, passedB: passed.b, maxPasserAdvance };
}

/**
 * Move-list features for the side to move — legal move count, checks and
 * captures available — plus opponent mobility via a turn flip when legal.
 * @cost ~1–2ms — two full legal-move generations.
 */
export function mobility(game) {
  const moves = game.moves({ verbose: true });
  const checksStm = moves.filter((m) => m.san.includes('+') || m.san.includes('#')).length;
  const capturesStm = moves.filter((m) => m.flags.includes('c') || m.flags.includes('e')).length;
  let mobilityOpp = null;
  const flipped = flipTurn(game.fen());
  if (validateFen(flipped).ok) {
    try {
      const g2 = new Chess(flipped);
      if (!g2.isCheck()) mobilityOpp = g2.moves().length;
    } catch { /* illegal flip (side to move giving check) */ }
  }
  return {
    mobilityStm: moves.length,
    mobilityOpp,
    mobilityGap: mobilityOpp == null ? null : Math.abs(moves.length - mobilityOpp),
    checksStm,
    capturesStm,
  };
}

/** The feature names allFeatures() emits, for ranking/reporting loops. */
export const RANKABLE_FEATURES = [
  'hangingTotal', 'tension', 'contacts', 'pinsTotal', 'ringAttackMax',
  'checksStm', 'capturesStm', 'mobilityGap', 'maxPasserAdvance', 'phase',
];

/**
 * Every static feature as one flat record (the features.jsonl row shape).
 * @cost ~2–5ms/position — the sum of the parts (attacks + mobility dominate).
 */
export function allFeatures(game) {
  return {
    ...material(game),
    inCheck: game.isCheck() ? 1 : 0,
    ...attacks(game),
    ...pins(game),
    ...kingSafety(game),
    ...passedPawns(game),
    ...mobility(game),
  };
}
