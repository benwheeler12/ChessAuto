// EnginePool: N Stockfish instances behind one in-memory async API, so a
// single Node program can compose engine-bound analysis without temp files
// or job shuffling. Instances live in forked child processes (the stockfish
// npm package refuses to initialize inside worker_threads) and speak over
// the built-in IPC channel.
//
// COST MODEL: an evaluate() call costs its movetime plus ~5–15ms of UCI
// overhead. Throughput scales with pool size until the CPU core count.
// Pipeline math: total engine time ≈ (Σ calls × movetime) / poolSize.
// stats() reports actual call counts and engine-milliseconds so a run's
// cost claims can be audited after the fact.

import { fork } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { fileURLToPath } from 'node:url';

const WORKER_PATH = fileURLToPath(new URL('./engine-worker.mjs', import.meta.url));

export class EnginePool {
  /** @param {number} [size] defaults to min(3, cores − 1) */
  constructor(size = Math.max(1, Math.min(3, availableParallelism() - 1))) {
    this.size = size;
    this.workers = []; // [{ worker, pending }]
    this.waiters = new Map(); // id -> resolve
    this.nextId = 1;
    this.calls = 0;
    this.engineMs = 0;
  }

  /** Fork and warm up the workers. @cost ~1–2s per worker (WASM init) */
  async init() {
    await Promise.all(Array.from({ length: this.size }, () => new Promise((resolve, reject) => {
      const worker = fork(WORKER_PATH, [], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
      const slot = { worker, pending: 0 };
      worker.on('message', (msg) => {
        if (msg.ready) {
          this.workers.push(slot);
          resolve();
          return;
        }
        slot.pending--;
        const waiter = this.waiters.get(msg.id);
        this.waiters.delete(msg.id);
        waiter?.(msg);
      });
      worker.on('error', reject);
    })));
    return this;
  }

  #dispatch(req) {
    const slot = this.workers.reduce((a, b) => (a.pending <= b.pending ? a : b));
    slot.pending++;
    this.calls++;
    return new Promise((resolve) => {
      this.waiters.set(req.id, (msg) => {
        this.engineMs += msg.ms ?? 0; // measured inside the worker: no queue wait
        resolve(msg);
      });
      slot.worker.send(req);
    });
  }

  /**
   * Evaluate a position. Returns centipawns from the SIDE TO MOVE's
   * perspective (mate mapped to ±9xxx). `moves` extends the position with a
   * UCI history so the engine sees repetitions and the halfmove clock.
   * @cost movetime + ~5–15ms
   */
  async evaluate(fen, { movetime = 80, moves = [] } = {}) {
    const { score } = await this.#dispatch({ id: this.nextId++, fen, moves, movetime });
    return score;
  }

  /** Best move and score for a position. @cost movetime + ~5–15ms */
  async bestMove(fen, { movetime = 300, moves = [] } = {}) {
    const { score, uci } = await this.#dispatch({
      id: this.nextId++, fen, moves, movetime, wantMove: true,
    });
    return { uci, score };
  }

  /** Actual usage so far — the auditable half of the cost model. */
  stats() {
    return { size: this.size, calls: this.calls, engineMs: Math.round(this.engineMs) };
  }

  async close() {
    for (const { worker } of this.workers) worker.kill();
    this.workers = [];
  }
}

/**
 * Run jobs with bounded concurrency (keeps a pool saturated when each job
 * makes serial engine calls). Results keep input order.
 * @cost the jobs' own cost ÷ effective parallelism
 */
export async function mapConcurrent(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}
