// Corpus feature analysis: samples positions from a PGN and writes one
// features.jsonl row per position (a cache other tools may reuse), plus a
// human-readable outlier report for eyeballing extreme positions.
//
// This is a thin composition over scripts/lib/{corpus,features}.mjs — the
// same functions any generator can call in memory without this file.
//
// Usage: node scripts/analyze-positions.mjs [--in data/lichess-games.pgn]
//   [--out data/features.jsonl] [--report data/feature-outliers.md]
//   [--first-ply 16] [--last-ply-margin 6] [--step 2]
//
// COST: ~4ms/position (replay + all static features); a 2,000-game corpus
// (~60k positions) takes ~4 minutes.

import { writeFileSync } from 'node:fs';
import { readCorpus, samplePositions } from './lib/corpus.mjs';
import { allFeatures, RANKABLE_FEATURES } from './lib/features.mjs';

const opt = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : dflt;
};
const IN = opt('in', 'data/lichess-games.pgn');
const OUT = opt('out', 'data/features.jsonl');
const REPORT = opt('report', 'data/feature-outliers.md');
const sampling = {
  firstPly: Number(opt('first-ply', 16)),
  lastPlyMargin: Number(opt('last-ply-margin', 6)),
  step: Number(opt('step', 2)),
};

const started = Date.now();
const games = readCorpus(IN);
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

writeFileSync(OUT, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
const ms = Date.now() - started;
console.error(`${rows.length} positions from ${games.length} games in ${ms}ms (${(ms / rows.length).toFixed(2)}ms/position incl. replay)`);

// ---- Outlier report ----
const link = (fen) => `https://lichess.org/analysis/standard/${fen.replaceAll(' ', '_')}`;

let md = `# T0 feature outliers\n\n${rows.length} positions sampled from ${games.length} games (${IN}).\n`;
md += `For each feature: the highest-scoring positions (max 2 per game), with links for eyeballing.\n`;

for (const feature of RANKABLE_FEATURES) {
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
