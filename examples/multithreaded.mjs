// multithreaded.mjs — demonstrate that catmandu-fix-js is safe to run across
// many threads in parallel, at arbitrary scale.
//
//   node examples/multithreaded.mjs [recordCount] [workerCount] [chunkSize]
//
// It transforms a deterministic dataset both single-threaded and across a pool
// of worker_threads, then proves the two results are identical via a streaming
// digest. Memory stays bounded, so you can crank recordCount into the millions:
//
//   node examples/multithreaded.mjs 5000000
//
// See lib.mjs for how the bounded pipeline and verification work.

import os from 'node:os';
import { runDemo } from './lib.mjs';

const total = Number(process.argv[2] ?? 200_000);
const workers = Number(process.argv[3] ?? Math.max(2, os.availableParallelism?.() ?? os.cpus().length));
const chunkSize = Number(process.argv[4] ?? 5_000);

// A non-trivial, fully deterministic Fix script: string ops, a derived field,
// a conditional, and a reject() that drops ~1/7 of records. Determinism is what
// lets single- and multi-threaded output match bit-for-bit.
const SCRIPT = `
  trim(title)
  upcase(title)
  copy_field(title, title_sort)
  downcase(title_sort)
  add_field(processed, yes)
  if exists(draft)
    reject()
  end
  if greater_than(score, 90)
    add_field(grade, A)
  end
`;

function makeRecord(i) {
  const rec = { id: i, title: `  Record number ${i}  `, score: i % 100 };
  if (i % 7 === 0) rec.draft = 1;
  return rec;
}

runDemo({
  title: 'catmandu-fix-js multithreaded demo',
  src: SCRIPT,
  total,
  workers,
  chunkSize,
  makeRecord,
}).catch((err) => {
  console.error(err);
  process.exit(1);
});
