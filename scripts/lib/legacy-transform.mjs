// Transforms legacy multi-mode puzzle objects (candidates/excluded/p3/p4/p5
// fields interpreted by prototype tabs) into self-describing contract
// puzzles: one puzzle object per playable experience.

/** Convert a legacy per-square line map to signature-keyed contract lines. */
function contractLines(bySquare, pieceType, keepSquare = () => true) {
  if (!bySquare) return undefined;
  const out = {};
  for (const [square, line] of Object.entries(bySquare)) {
    if (!keepSquare(square)) continue;
    out[`${pieceType}@${square}`] = line;
  }
  return Object.keys(out).length ? out : undefined;
}

const sig = (pieceType, square) => `${pieceType}@${square}`;

/**
 * Expand one legacy puzzle into contract puzzles, one per mode it supports.
 * @returns {{mode: 'candidates'|'hidden'|'opponent-first'|'open'|'open-p5', puzzle: object}[]}
 */
export function legacyToContract(legacy) {
  const type = legacy.place[0];
  const out = [];
  const base = {
    name: legacy.name,
    description: legacy.description,
    fen: legacy.fen,
    player: legacy.player,
    place: legacy.place,
  };
  const meta = (extra = {}) => ({
    ...(legacy.source ? { source: legacy.source } : {}),
    ...extra,
  });

  if (legacy.candidates) {
    out.push({
      mode: 'candidates',
      puzzle: {
        ...base,
        firstMove: 'player',
        placement: { allowed: [...legacy.candidates] },
        solutions: [sig(type, legacy.solution)],
        lines: contractLines(legacy.lines?.own, type, (sq) => legacy.candidates.includes(sq)),
        meta: meta(),
      },
    });
  }
  if (legacy.excluded?.length) {
    out.push({
      mode: 'hidden',
      puzzle: {
        ...base,
        firstMove: 'player',
        placement: { blocked: [...legacy.excluded] },
        solutions: [sig(type, legacy.solution)],
        lines: contractLines(legacy.lines?.own, type, (sq) => !legacy.excluded.includes(sq)),
        meta: meta(),
      },
    });
  }
  if (legacy.p3) {
    out.push({
      mode: 'opponent-first',
      puzzle: {
        ...base,
        firstMove: 'opponent',
        // A position may have had nothing obvious to block — omit the
        // constraint entirely rather than shipping an empty list.
        ...(legacy.p3.excluded.length ? { placement: { blocked: [...legacy.p3.excluded] } } : {}),
        solutions: [sig(type, legacy.p3.solution)],
        lines: contractLines(legacy.lines?.opp, type, (sq) => !legacy.p3.excluded.includes(sq)),
        meta: meta(),
      },
    });
  }
  for (const [field, mode] of [['p4', 'open'], ['p5', 'open-p5']]) {
    const set = legacy[field];
    if (!set) continue;
    out.push({
      mode,
      puzzle: {
        ...base,
        firstMove: 'opponent',
        solutions: set.solutions.map((sq) => sig(type, sq)),
        lines: contractLines(legacy.lines?.opp, type),
        meta: meta(set.foundBy ? { foundBy: set.foundBy } : {}),
      },
    });
  }
  // Free-placement classics: no mode fields at all.
  if (!legacy.candidates && !legacy.excluded && !legacy.p3 && !legacy.p4 && !legacy.p5) {
    out.push({
      mode: 'free',
      puzzle: { ...base, firstMove: 'player', meta: meta() },
    });
  }
  return out;
}
