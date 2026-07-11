// Small pipeline conveniences shared by the generator CLIs: feature-row
// loading with a transparent cache, and uniform stage logging so every run
// leaves an auditable trail of counts and timings.

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { readCorpus, samplePositions } from './corpus.mjs';
import { allFeatures } from './features.mjs';

/**
 * Feature rows for a corpus, computed in memory (~4ms/position). If a cache
 * path is given, a fresh cache (newer than the PGN) is reused and a newly
 * computed set is written back — so repeat runs cost milliseconds, not
 * minutes, without any separate pipeline step.
 * @returns {{rows: object[], games: number, fromCache: boolean}}
 * @cost cache hit: ~0.5s per 60k rows; miss: ~4ms × positions
 */
export function featureRows(pgnPath, { cachePath = null, sampling = {} } = {}) {
  if (cachePath && existsSync(cachePath)
    && statSync(cachePath).mtimeMs > statSync(pgnPath).mtimeMs) {
    const rows = readFileSync(cachePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const games = new Set(rows.map((r) => r.game)).size;
    return { rows, games, fromCache: true };
  }
  const games = readCorpus(pgnPath);
  const rows = [];
  for (const [gameIdx, parsed] of games.entries()) {
    for (const sample of samplePositions(parsed, sampling)) {
      rows.push({
        game: gameIdx,
        site: parsed.site,
        ply: sample.ply,
        moveNo: sample.moveNo,
        turn: sample.turn,
        fen: sample.fen,
        ...allFeatures(sample.game),
      });
    }
  }
  if (cachePath) writeFileSync(cachePath, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return { rows, games: games.length, fromCache: false };
}

/** Log a stage's duration and result count: `stage(label)(count)` pattern. */
export function stageTimer(label) {
  const started = performance.now();
  return (detail) => {
    console.error(`[${label}] ${detail} (${Math.round(performance.now() - started)}ms)`);
  };
}
