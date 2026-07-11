// Forked child host for one Stockfish (lite-single WASM) instance. The
// stockfish npm package refuses to initialize inside Node worker_threads,
// so EnginePool (engine.mjs) forks these as child processes and talks over
// the built-in IPC channel — still one program, no temp files.
//   in:  { id, fen, moves?, movetime, wantMove? }
//   out: { id, score, uci? }   (score is side-to-move centipawns, mate → ±9xxx)
// Requests are answered strictly in order.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const engine = await require('stockfish')('lite-single');
const listeners = new Set();
engine.listener = (line) => { for (const l of [...listeners]) l(line); };
const command = (cmd, until) => new Promise((resolve) => {
  const l = (line) => { if (until(line)) { listeners.delete(l); resolve(line); } };
  listeners.add(l);
  engine.sendCommand(cmd);
});
await command('uci', (l) => l === 'uciok');
engine.sendCommand('setoption name Hash value 64');
await command('isready', (l) => l === 'readyok');

async function search({ fen, moves = [], movetime }) {
  let score = 0;
  engine.sendCommand(`position fen ${fen}${moves.length ? ` moves ${moves.join(' ')}` : ''}`);
  const bestmove = await command(`go movetime ${movetime}`, (line) => {
    const m = /score (cp|mate) (-?\d+)/.exec(line);
    if (m) {
      score = m[1] === 'mate'
        ? Math.sign(Number(m[2])) * (10000 - Math.abs(Number(m[2])))
        : Number(m[2]);
    }
    return line.startsWith('bestmove');
  });
  return { score, uci: bestmove.split(/\s+/)[1] };
}

let chain = Promise.resolve();
process.send({ ready: true });
process.on('message', (req) => {
  chain = chain.then(async () => {
    const { score, uci } = await search(req);
    process.send({ id: req.id, score, uci: req.wantMove ? uci : undefined });
  });
});
