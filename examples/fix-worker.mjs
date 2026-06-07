// fix-worker.mjs — the worker side of the multithreaded demos.
//
// Each worker thread is its own V8 isolate with its own copy of the
// catmandu-fix-js module. It compiles the Fix *source string* once (functions
// can't be shipped across threads — only the harmless source string is), then
// transforms whatever chunks of records the main thread posts to it.
//
// Crucially, the worker does NOT send transformed records back. It folds each
// chunk's output into a SHA-1 digest and returns only {id, kept, digest}. That
// keeps the worker -> main messages tiny and the whole pipeline memory-bounded,
// no matter how many records flow through. (Shipping millions of records back
// is what OOMs the main thread's deserializer — and it isn't needed to prove
// the transform ran correctly.)

import { parentPort, workerData } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import { compileFix, REJECT } from '../dist/index.js';

// compileFix parses + builds once; the returned function is a pure
// record -> record transform.
const run = compileFix(workerData.src);

parentPort.on('message', ({ id, records }) => {
  const h = createHash('sha1');
  let kept = 0;
  for (const rec of records) {
    const r = run(rec);
    if (r === REJECT) continue; // reject() dropped this record
    kept++;
    h.update(JSON.stringify(r));
  }
  parentPort.postMessage({ id, kept, digest: h.digest('hex') });
});
