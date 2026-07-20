// Puzzle collections. Each batch file is immutable once shipped: generators
// drop NEW batch-*.js files into this directory rather than editing old
// ones, so "what's newest" is always derivable and regeneration never
// clobbers existing sets. Batch files are auto-discovered — no imports to
// maintain here.
//
// A batch file exports an array of contract puzzles (see
// src/puzzle-contract.js); every puzzle carries meta.batch
// { id, label, createdAt, generator }.

const modules = import.meta.glob('./batch-*.js', { eager: true });

const BATCHES = Object.keys(modules)
  .sort()
  .map((path) => modules[path].default)
  .filter((puzzles) => puzzles?.length);

/** The finished product shows exactly one collection: The Final Set
 * (b018). Other batch files remain on disk as the curation corpus and
 * for generator dedup, but the UI never sees them. */
export const COLLECTIONS = BATCHES
  .map((puzzles) => ({ ...puzzles[0].meta.batch, puzzles }))
  .filter((c) => c.id === 'b018');

export const PUZZLES = COLLECTIONS.flatMap((c) => c.puzzles);
