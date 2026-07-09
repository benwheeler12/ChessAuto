// Copies the Stockfish WASM build from node_modules into public/ so Vite
// serves it as a static asset (it must be loaded as a classic web worker,
// not bundled as a module).
import { cpSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'node_modules', 'stockfish', 'bin');
const dest = join(root, 'public', 'stockfish');

mkdirSync(dest, { recursive: true });
for (const file of ['stockfish-18-lite-single.js', 'stockfish-18-lite-single.wasm']) {
  cpSync(join(src, file), join(dest, file));
}
console.log('Copied Stockfish WASM build to public/stockfish/');
