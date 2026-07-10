// T0 position-feature extractor: iterates games, samples positions, and
// computes ONLY the cheap static features (chess.js, no engine — ~1ms per
// position). Writes one JSON row per position plus an outlier report so we
// can eyeball which feature extremes correspond to fun puzzle material.
//
// Usage: node scripts/analyze-positions.mjs [--in data/lichess-games.pgn]
//   [--out data/features.jsonl] [--report data/feature-outliers.md]
//   [--first-ply 16] [--last-ply-margin 6] [--step 2]

import { readFileSync, writeFileSync } from 'node:fs';
import { Chess, validateFen } from 'chess.js';
import { flipTurn } from '../src/fen.js';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const IN = opt('in', 'data/lichess-games.pgn');
const OUT = opt('out', 'data/features.jsonl');
const REPORT = opt('report', 'data/feature-outliers.md');
const FIRST_PLY = Number(opt('first-ply', 16));
const LAST_PLY_MARGIN = Number(opt('last-ply-margin', 6));
const STEP = Number(opt('step', 2));

const VALUES = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 0 };
const FILES = 'abcdefgh';
const DIRS = {
  rook: [[1, 0], [-1, 0], [0, 1], [0, -1]],
  bishop: [[1, 1], [1, -1], [-1, 1], [-1, -1]],
};

/** All static features for one position. ~1ms. */
function extractFeatures(game) {
  const board = game.board(); // ranks 8..1
  const pieceAt = (f, r) => (f >= 0 && f < 8 && r >= 1 && r <= 8 ? board[8 - r][f] : undefined);
  const pieces = board.flat().filter(Boolean);

  const material = { w: 0, b: 0 };
  const kings = {};
  for (const piece of pieces) {
    material[piece.color] += VALUES[piece.type];
    if (piece.type === 'k') kings[piece.color] = piece.square;
  }
  const phase = material.w + material.b
    - pieces.filter((p) => p.type === 'p').length; // non-pawn material

  // Attack-based counts
  const counts = {
    attacked: { w: 0, b: 0 },   // pieces of X attacked by the enemy
    hanging: { w: 0, b: 0 },    // attacked and (undefended or cheaper attacker)
    contacts: 0,                // total attacker->enemy-piece pairs
  };
  for (const piece of pieces) {
    if (piece.type === 'k') continue;
    const enemy = piece.color === 'w' ? 'b' : 'w';
    const attackers = game.attackers(piece.square, enemy);
    if (!attackers.length) continue;
    counts.attacked[piece.color]++;
    counts.contacts += attackers.length;
    const defenders = game.attackers(piece.square, piece.color);
    const cheapest = Math.min(...attackers.map((sq) => {
      const att = pieceAt(FILES.indexOf(sq[0]), Number(sq[1]));
      return att ? VALUES[att.type] || 99 : 99;
    }));
    if (!defenders.length || cheapest < VALUES[piece.type]) counts.hanging[piece.color]++;
  }

  // Absolute pins via ray walk from each king
  const pins = { w: 0, b: 0 };
  for (const color of ['w', 'b']) {
    const king = kings[color];
    if (!king) continue;
    const kf = FILES.indexOf(king[0]);
    const kr = Number(king[1]);
    for (const [kind, dirs] of Object.entries(DIRS)) {
      for (const [df, dr] of dirs) {
        let f = kf + df, r = kr + dr, shield = null;
        while (true) {
          const piece = pieceAt(f, r);
          if (piece === undefined) break; // off board
          if (piece) {
            if (!shield) {
              if (piece.color !== color) break;
              shield = piece;
            } else {
              if (piece.color !== color && (piece.type === 'q' || piece.type === (kind === 'rook' ? 'r' : 'b'))) {
                pins[color]++;
              }
              break;
            }
          }
          f += df; r += dr;
        }
      }
    }
  }

  // King safety geometry
  const kingSafety = {};
  for (const color of ['w', 'b']) {
    const king = kings[color];
    const enemy = color === 'w' ? 'b' : 'w';
    const kf = FILES.indexOf(king[0]);
    const kr = Number(king[1]);
    let shield = 0, ringAttack = 0, openFiles = 0;
    const forward = color === 'w' ? 1 : -1;
    for (let df = -1; df <= 1; df++) {
      // pawn shield: own pawns 1-2 squares ahead in the king's 3 files
      for (const dr of [forward, 2 * forward]) {
        const p = pieceAt(kf + df, kr + dr);
        if (p && p.type === 'p' && p.color === color) { shield++; break; }
      }
      // open file: no own pawn anywhere on the file
      const file = kf + df;
      if (file >= 0 && file < 8) {
        let ownPawn = false;
        for (let r = 1; r <= 8; r++) {
          const p = pieceAt(file, r);
          if (p && p.type === 'p' && p.color === color) { ownPawn = true; break; }
        }
        if (!ownPawn) openFiles++;
      }
      // ring attackers
      for (let dr = -1; dr <= 1; dr++) {
        if (!df && !dr) continue;
        const f = kf + df, r = kr + dr;
        if (f < 0 || f > 7 || r < 1 || r > 8) continue;
        ringAttack += game.attackers(FILES[f] + r, enemy).length;
      }
    }
    kingSafety[color] = { shield, ringAttack, openFiles };
  }

  // Passed pawns
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

  // Move-list features (side to move; opponent via turn flip when legal)
  const moves = game.moves({ verbose: true });
  const checksStm = moves.filter((m) => m.san.includes('+') || m.san.includes('#')).length;
  const capturesStm = moves.filter((m) => m.flags.includes('c') || m.flags.includes('e')).length;
  let mobilityOpp = null;
  const flipped = flipTurn(game.fen());
  if (validateFen(flipped).ok) {
    try {
      const g2 = new Chess(flipped);
      if (!g2.isCheck()) mobilityOpp = g2.moves().length;
    } catch { /* illegal flip (side to move in check) */ }
  }

  return {
    materialW: material.w,
    materialB: material.b,
    materialDiff: material.w - material.b,
    phase,
    inCheck: game.isCheck() ? 1 : 0,
    tension: counts.attacked.w + counts.attacked.b,
    contacts: counts.contacts,
    hangingW: counts.hanging.w,
    hangingB: counts.hanging.b,
    hangingTotal: counts.hanging.w + counts.hanging.b,
    pinsW: pins.w,
    pinsB: pins.b,
    pinsTotal: pins.w + pins.b,
    shieldW: kingSafety.w.shield,
    shieldB: kingSafety.b.shield,
    ringAttackW: kingSafety.w.ringAttack,
    ringAttackB: kingSafety.b.ringAttack,
    ringAttackMax: Math.max(kingSafety.w.ringAttack, kingSafety.b.ringAttack),
    openFilesNearKingW: kingSafety.w.openFiles,
    openFilesNearKingB: kingSafety.b.openFiles,
    passedW: passed.w,
    passedB: passed.b,
    maxPasserAdvance,
    mobilityStm: moves.length,
    mobilityOpp,
    mobilityGap: mobilityOpp == null ? null : Math.abs(moves.length - mobilityOpp),
    checksStm,
    capturesStm,
  };
}

// ---- Run over the corpus ----
const started = Date.now();
const text = readFileSync(IN, 'utf8');
const chunks = text.split(/\n\n(?=\[Event )/).filter((c) => c.trim());
const rows = [];

for (const [gameIdx, chunk] of chunks.entries()) {
  const game = new Chess();
  try {
    game.loadPgn(chunk);
  } catch {
    continue;
  }
  const site = chunk.match(/\[Site "([^"]*)"/)?.[1] ?? `game-${gameIdx}`;
  const moves = game.history();
  const replay = new Chess();
  for (let ply = 1; ply <= moves.length; ply++) {
    replay.move(moves[ply - 1]);
    if (ply < FIRST_PLY || ply > moves.length - LAST_PLY_MARGIN || ply % STEP) continue;
    rows.push({
      game: gameIdx,
      site,
      ply,
      moveNo: replay.moveNumber(),
      turn: replay.turn(),
      fen: replay.fen(),
      ...extractFeatures(replay),
    });
  }
}

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const ms = Date.now() - started;
console.error(`${rows.length} positions from ${chunks.length} games in ${ms}ms (${(ms / rows.length).toFixed(2)}ms/position incl. replay)`);

// ---- Outlier report ----
const REPORT_FEATURES = [
  'hangingTotal', 'tension', 'contacts', 'pinsTotal', 'ringAttackMax',
  'checksStm', 'capturesStm', 'mobilityGap', 'maxPasserAdvance', 'phase',
];

function link(fen) {
  return `https://lichess.org/analysis/standard/${fen.replaceAll(' ', '_')}`;
}

let md = `# T0 feature outliers\n\n${rows.length} positions sampled from ${chunks.length} games (${IN}).\n`;
md += `For each feature: the highest-scoring positions (max 2 per game), with links for eyeballing.\n`;

for (const feature of REPORT_FEATURES) {
  const usable = rows.filter((r) => r[feature] != null);
  usable.sort((a, b) => b[feature] - a[feature]);
  const picked = [];
  const perGame = new Map();
  for (const row of usable) {
    const n = perGame.get(row.game) ?? 0;
    if (n >= 2) continue;
    perGame.set(row.game, n + 1);
    picked.push(row);
    if (picked.length >= 5) break;
  }
  const values = usable.map((r) => r[feature]);
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  md += `\n## ${feature}\n\nmean ${mean.toFixed(2)}, max ${values[0] ?? '-'}\n\n`;
  for (const row of picked) {
    md += `- **${row[feature]}** — game ${row.game} (${row.site}), move ${row.moveNo}, ${row.turn === 'w' ? 'White' : 'Black'} to move — [analyze](${link(row.fen)})\n  \`${row.fen}\`\n`;
  }
}

writeFileSync(REPORT, md);
console.error(`Report → ${REPORT}`);
