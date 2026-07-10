// Streams a Lichess monthly database dump (zstd-compressed PGN) and keeps
// the first N games matching quality filters, then stops the download.
// The full dumps are ~30 GB; we typically read only a few MB.
//
// Usage: node scripts/fetch-lichess-games.mjs [--month 2026-06] [--count 100]
//   [--min-elo 2300] [--min-base 180] [--out data/lichess-games.pgn]

import { createWriteStream } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { spawn } from 'node:child_process';
import { Chess } from 'chess.js';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const MONTH = opt('month', '2026-06');
const COUNT = Number(opt('count', 100));
const MIN_ELO = Number(opt('min-elo', 2300));
const MIN_BASE = Number(opt('min-base', 180)); // seconds; excludes bullet
const OUT = opt('out', 'data/lichess-games.pgn');
const URL = `https://database.lichess.org/standard/lichess_db_standard_rated_${MONTH}.pgn.zst`;

// curl honors the environment's HTTPS proxy (Node's fetch does not).
const curl = spawn('curl', ['-sS', '--fail', URL], { stdio: ['ignore', 'pipe', 'inherit'] });

// Lichess dumps use the seekable-zstd format, which opens with a skippable
// frame that Node's decoder rejects — strip any leading skippable frames.
let headStripped = false;
let headBuf = Buffer.alloc(0);
function stripSkippable(chunk) {
  if (headStripped) return chunk;
  headBuf = Buffer.concat([headBuf, chunk]);
  while (headBuf.length >= 8) {
    const magic = headBuf.readUInt32LE(0);
    if (magic >= 0x184d2a50 && magic <= 0x184d2a5f) {
      const size = headBuf.readUInt32LE(4);
      if (headBuf.length < 8 + size) return Buffer.alloc(0); // need more bytes
      headBuf = headBuf.subarray(8 + size);
    } else {
      headStripped = true;
      const rest = headBuf;
      headBuf = Buffer.alloc(0);
      return rest;
    }
  }
  return Buffer.alloc(0);
}

const out = createWriteStream(OUT);
const zstd = createZstdDecompress();
let buffer = '';
let kept = 0;
let seen = 0;
let bytesIn = 0;

/** Strip {comments}, NAGs and annotation glyphs so chess.js parses cleanly. */
function sanitizeMoves(text) {
  return text
    .replace(/\{[^}]*\}/g, ' ')
    .replace(/\$\d+/g, '')
    .replace(/[?!]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function tryKeep(headerBlock, movesBlock) {
  seen++;
  const header = (name) => headerBlock.match(new RegExp(`\\[${name} "([^"]*)"`))?.[1];
  const white = Number(header('WhiteElo'));
  const black = Number(header('BlackElo'));
  const result = header('Result');
  const base = Number((header('TimeControl') ?? '0+0').split('+')[0]);
  const termination = header('Termination') ?? '';
  if (!(white >= MIN_ELO && black >= MIN_ELO)) return;
  if (result !== '1-0' && result !== '0-1') return;
  if (base < MIN_BASE) return;
  if (/abandon|rules/i.test(termination)) return;

  const moves = sanitizeMoves(movesBlock);
  if (moves.split(' ').length < 60) return; // want real middlegames

  // Keep only the headers downstream tools care about, plus a clean movetext.
  const keepHeaders = ['Event', 'Site', 'Date', 'White', 'Black', 'Result', 'WhiteElo', 'BlackElo', 'TimeControl']
    .map((name) => (header(name) != null ? `[${name} "${header(name)}"]` : null))
    .filter(Boolean)
    .join('\n');
  const pgn = `${keepHeaders}\n\n${moves}\n`;
  try {
    new Chess().loadPgn(pgn); // final sanity check
  } catch {
    return;
  }
  out.write(pgn + '\n');
  kept++;
  if (kept % 10 === 0) console.error(`kept ${kept}/${COUNT} (scanned ${seen} games, ${(bytesIn / 1e6).toFixed(1)} MB downloaded)`);
}

function processBuffer(final = false) {
  // Games start at [Event; split on blank line before the next [Event.
  const parts = buffer.split(/\n\n(?=\[Event )/);
  const whole = final ? parts : parts.slice(0, -1);
  if (!final) buffer = parts[parts.length - 1];
  for (const chunk of whole) {
    const split = chunk.indexOf('\n\n');
    if (split < 0) continue;
    tryKeep(chunk.slice(0, split), chunk.slice(split + 2));
    if (kept >= COUNT) return true;
  }
  return false;
}

function finalize(note) {
  processBuffer(true);
  out.end();
  console.error(`\n${note}: ${kept} games → ${OUT} (scanned ${seen}, downloaded ${(bytesIn / 1e6).toFixed(1)} MB)`);
  process.exit(kept > 0 ? 0 : 1);
}
zstd.on('error', () => finalize('decoder stopped (mid-stream frame)'));

zstd.on('data', (data) => {
  buffer += data.toString('utf8');
  if (buffer.length > 4e6 || buffer.includes('\n\n[Event ')) {
    if (processBuffer()) {
      out.end();
      console.error(`\nDone: ${kept} games → ${OUT} (scanned ${seen}, downloaded ${(bytesIn / 1e6).toFixed(1)} MB)`);
      process.exit(0);
    }
  }
});

for await (const chunk of curl.stdout) {
  bytesIn += chunk.length;
  const usable = stripSkippable(chunk);
  if (usable.length && !zstd.write(usable)) {
    await new Promise((resolve) => zstd.once('drain', resolve));
  }
}
zstd.end();
finalize('stream ended');
