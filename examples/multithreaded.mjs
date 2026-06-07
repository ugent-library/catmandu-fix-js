// multithreaded.mjs — fan a compiled Fix out across worker_threads.
//
//   node examples/multithreaded.mjs [recordCount] [workerCount]
//
// This single file is both the main thread and the worker (selected by
// isMainThread). Each worker is its own isolate: it receives the Fix SOURCE
// STRING (functions can't cross threads), compiles its own runner, and
// transforms the records it's sent. Records travel by message — postMessage
// makes a structured-clone copy — so nothing is shared between threads.

import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { compileFix, REJECT } from '../dist/index.js';

const SCRIPT = `
  trim(title)
  upcase(title)
  add_field(processed, yes)
  if exists(draft)
    reject()
  end
`;

if (!isMainThread) {
  // ---- worker side ----
  const run = compileFix(workerData.src);
  parentPort.on('message', ({ id, records }) => {
    const out = [];
    for (const rec of records) {
      const r = run(rec);
      if (r !== REJECT) out.push(r); // reject() drops the record
    }
    parentPort.postMessage({ id, out });
  });
} else {
  // ---- main side ----
  const total = Number(process.argv[2] ?? 12);
  const workerCount = Number(process.argv[3] ?? Math.max(2, os.availableParallelism?.() ?? 4));

  const makeRecord = (i) => {
    const rec = { id: i, title: `  Record ${i}  ` };
    if (i % 5 === 0) rec.draft = 1; // every 5th record is reject()ed
    return rec;
  };

  // Split the dataset into one chunk per worker.
  const chunkSize = Math.max(1, Math.ceil(total / workerCount));
  const chunks = [];
  for (let start = 0; start < total; start += chunkSize) {
    const records = [];
    for (let i = start; i < Math.min(start + chunkSize, total); i++) records.push(makeRecord(i));
    chunks.push(records);
  }

  const workers = chunks.map(() => new Worker(fileURLToPath(import.meta.url), { workerData: { src: SCRIPT } }));

  const results = await Promise.all(
    chunks.map((records, id) => new Promise((resolve, reject) => {
      workers[id].once('message', ({ out }) => resolve(out));
      workers[id].once('error', reject);
      workers[id].postMessage({ id, records });
    })),
  );

  await Promise.all(workers.map((w) => w.terminate()));

  const transformed = results.flat();
  console.log(`transformed ${transformed.length} of ${total} records across ${chunks.length} workers`);
  for (const r of transformed.slice(0, 5)) console.log('  ', JSON.stringify(r));
}
