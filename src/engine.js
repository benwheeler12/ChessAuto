// Thin promise-based wrapper around a Stockfish WASM web worker speaking UCI.

const SCORE_RE = /score (cp|mate) (-?\d+)/;

export class Engine {
  constructor(name = 'engine') {
    this.name = name;
    this.worker = null;
    this.listeners = new Set();
  }

  init() {
    this.initPromise ??= this.#doInit();
    return this.initPromise;
  }

  async #doInit() {
    const url = `${import.meta.env.BASE_URL}stockfish/stockfish-18-lite-single.js`;
    this.worker = new Worker(url);
    this.worker.onmessage = (e) => {
      const line = typeof e.data === 'string' ? e.data : e.data?.data;
      if (typeof line !== 'string') return;
      for (const listener of [...this.listeners]) listener(line);
    };
    const ready = this.waitFor((l) => l === 'uciok');
    this.send('uci');
    await ready;
    this.send('setoption name Hash value 32');
    await this.isReady();
  }

  send(cmd) {
    this.worker.postMessage(cmd);
  }

  waitFor(predicate, onLine) {
    return new Promise((resolve) => {
      const listener = (line) => {
        onLine?.(line);
        if (predicate(line)) {
          this.listeners.delete(listener);
          resolve(line);
        }
      };
      this.listeners.add(listener);
    });
  }

  async isReady() {
    const p = this.waitFor((l) => l === 'readyok');
    this.send('isready');
    await p;
  }

  async newGame() {
    this.send('ucinewgame');
    await this.isReady();
  }

  /**
   * Search a position and return the best move plus the engine's score
   * (from the side-to-move's perspective). Pass the moves played since
   * `fen` so the engine knows the game history — without it, it cannot
   * see (and avoid) threefold repetitions.
   * @param {string} fen starting position
   * @param {number} movetimeMs
   * @param {string[]} [moves] UCI moves played from `fen` to the current position
   * @returns {Promise<{move: string, score: {type: 'cp'|'mate', value: number}|null}>}
   */
  async search(fen, movetimeMs, moves = []) {
    let score = null;
    this.send(`position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
    const done = this.waitFor(
      (l) => l.startsWith('bestmove'),
      (l) => {
        if (l.startsWith('info')) {
          const m = SCORE_RE.exec(l);
          if (m) score = { type: m[1], value: Number(m[2]) };
        }
      },
    );
    this.send(`go movetime ${movetimeMs}`);
    const line = await done;
    return { move: line.split(/\s+/)[1], score };
  }

  stop() {
    this.worker?.postMessage('stop');
  }
}

/** Convert a UCI score to centipawns from White's perspective. */
export function scoreToWhiteCp(score, sideToMove) {
  if (!score) return 0;
  let cp = score.type === 'mate'
    ? Math.sign(score.value) * (10000 - Math.abs(score.value))
    : score.value;
  return sideToMove === 'w' ? cp : -cp;
}
