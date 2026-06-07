// multithreaded-marc.mjs — like multithreaded.mjs, but exercises the MARC
// fixes. This is the interesting case for thread-safety: marc_map/marc_match
// memoize parsed find-paths in a module-level Map (`findCache`). This demo
// confirms running marc_map across a worker pool yields output identical to a
// single-threaded run, at arbitrary scale.
//
//   node examples/multithreaded-marc.mjs [recordCount] [workerCount] [chunkSize]
//
//   node examples/multithreaded-marc.mjs 5000000   # bounded memory — fine

import os from 'node:os';
import { runDemo } from './lib.mjs';

const total = Number(process.argv[2] ?? 100_000);
const workers = Number(process.argv[3] ?? Math.max(2, os.availableParallelism?.() ?? os.cpus().length));
const chunkSize = Number(process.argv[4] ?? 5_000);

// Several marc_map calls on different find-paths, so every worker populates and
// reads its find-cache concurrently (within its own isolate).
const SCRIPT = `
  marc_map(245a, title)
  marc_map(245b, subtitle)
  marc_map(100a, author)
  marc_map(650a, subjects.$append)
  marc_remove(650)
  add_field(format, marc)
`;

function makeRecord(i) {
  return {
    id: i,
    record: [
      ['LDR', ' ', ' ', '_', '00000nam a2200000 a 4500'],
      ['100', '1', ' ', 'a', `Author ${i}`],
      ['245', '1', '0', 'a', `Title ${i}`, 'b', `subtitle ${i}`],
      ['650', ' ', '0', 'a', `Subject ${i % 50}`],
      ['650', ' ', '0', 'a', `Topic ${i % 30}`],
    ],
  };
}

runDemo({
  title: 'catmandu-fix-js MARC multithreaded demo',
  src: SCRIPT,
  total,
  workers,
  chunkSize,
  makeRecord,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
