// Engine-backed qualification primitives. Every function takes an
// EnginePool (engine.mjs) as its first argument and is otherwise stateless,
// so generators compose them freely and the pool's stats() stay the single
// audit point for engine spend.
//
// COST MODEL (dominates every pipeline that uses it):
//   evaluatePlayer    = 1 × movetime
//   scanPlacements    = |placements| × movetime           (parallelizes)
//   playLine          ≈ plies × movetime per attempt, retried up to
//                       |movetimes| times on verdict mismatch

import { Chess } from 'chess.js';

/**
 * Evaluate a position from a given player's perspective, in centipawns
 * (mate mapped to ±9xxx). @cost movetime
 */
export async function evaluatePlayer(pool, fen, player, { movetime = 80, moves = [] } = {}) {
  const score = await pool.evaluate(fen, { movetime, moves });
  return fen.split(' ')[1] === player ? score : -score;
}

/**
 * Score a batch of candidate placements ({square|sig, fen}) from the
 * player's perspective, saturating the pool.
 * @returns the same entries with a `cp` field, input order preserved
 * @cost (|placements| × movetime) / poolSize
 */
export async function scanPlacements(pool, placements, player, { movetime = 80 } = {}) {
  return Promise.all(placements.map(async (candidate) => ({
    ...candidate,
    cp: await evaluatePlayer(pool, candidate.fen, player, { movetime }),
  })));
}

/**
 * Play a position out engine-vs-engine to a terminal state and check it
 * against an expected verdict ('win' = the player mates, 'notwin' = anything
 * else). Retries at each movetime in the ladder until the outcome matches;
 * returns the last line either way.
 * @returns {{moves: string[], evals: number[], terminal: boolean,
 *            playerWon: boolean, matched: boolean}} evals are white-perspective
 * @cost ≈ game length (typically 40–200 plies) × movetime per attempt
 */
export async function playLine(pool, startFen, player, {
  movetimes = [60, 150, 300],
  plyCap = 300,
  expect = null,
} = {}) {
  let line = null;
  for (const movetime of movetimes) {
    const game = new Chess(startFen);
    const moves = [];
    const evals = [];
    while (!game.isGameOver() && moves.length < plyCap) {
      const side = game.turn();
      const { uci, score } = await pool.bestMove(startFen, { moves, movetime });
      if (!uci || uci === '(none)') break;
      game.move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] });
      moves.push(uci);
      evals.push(side === 'w' ? (score ?? 0) : -(score ?? 0));
    }
    const playerWon = game.isCheckmate() && game.turn() !== player;
    const terminal = game.isGameOver();
    line = {
      moves,
      evals,
      terminal,
      playerWon,
      matched: expect === null || (terminal && (expect === 'win' ? playerWon : !playerWon)),
    };
    if (line.matched) break;
  }
  return line;
}
