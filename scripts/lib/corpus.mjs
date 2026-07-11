// Corpus access: turning PGN text into replayable games and sampled
// positions, entirely in memory. Network acquisition stays in
// scripts/fetch-lichess-games.mjs (a streaming concern, not a library one).
//
// COST MODEL: parsing is chess.js loadPgn-bound, ~2–5ms per game; replaying
// costs ~30µs per ply. Sampling a 2,000-game corpus into ~60k positions
// takes a few seconds before any feature work happens.

import { readFileSync } from 'node:fs';
import { Chess } from 'chess.js';

/** Split a PGN file's text into per-game chunks. @cost ~µs per game */
export function splitPgn(text) {
  return text.split(/\n\n(?=\[Event )/).filter((c) => c.trim());
}

/**
 * Parse one PGN chunk. Returns null for unparseable games.
 * @returns {{ headers: Record<string,string>, moves: string[], site: string }}
 * @cost ~2–5ms per game (chess.js loadPgn)
 */
export function parseGame(chunk, index = 0) {
  const game = new Chess();
  try {
    game.loadPgn(chunk);
  } catch {
    return null;
  }
  const headers = game.getHeaders();
  return {
    headers,
    moves: game.history(),
    site: headers.Site ?? `game-${index}`,
    white: headers.White ?? '?',
    black: headers.Black ?? '?',
  };
}

/** Read and parse a whole PGN file. @cost ~2–5ms × games */
export function readCorpus(path) {
  return splitPgn(readFileSync(path, 'utf8'))
    .map((chunk, i) => parseGame(chunk, i))
    .filter(Boolean);
}

/**
 * Replay a parsed game, yielding sampled positions. The yielded `game` is a
 * LIVE Chess instance that advances on the next iteration — consume it (or
 * take its fen) before pulling the next sample; clone with new Chess(fen)
 * if you need to keep it.
 * @param {{moves: string[]}} parsed
 * @param {{firstPly?: number, lastPlyMargin?: number, step?: number}} opts
 * @yields {{ply: number, moveNo: number, turn: 'w'|'b', fen: string, game: Chess}}
 * @cost ~30µs per ply replayed
 */
export function* samplePositions(parsed, { firstPly = 16, lastPlyMargin = 6, step = 2 } = {}) {
  const replay = new Chess();
  for (let ply = 1; ply <= parsed.moves.length; ply++) {
    replay.move(parsed.moves[ply - 1]);
    if (ply < firstPly || ply > parsed.moves.length - lastPlyMargin || ply % step) continue;
    yield {
      ply,
      moveNo: replay.moveNumber(),
      turn: replay.turn(),
      fen: replay.fen(),
      game: replay,
    };
  }
}
