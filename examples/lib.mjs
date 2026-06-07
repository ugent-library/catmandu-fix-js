// lib.mjs — shared driver for the multithreaded demos.
//
// Both demos prove the same thing: transforming a dataset across N worker
// threads produces a result IDENTICAL to a single-threaded run. The trick to
// making that scale to millions of records is to never hold the whole dataset
// (or the whole result) in memory:
//
//   * Records are generated lazily, one chunk at a time.
//   * A persistent pool of workers is kept alive; chunks are dispatched with
//     backpressure, so only ~poolSize chunks are ever in flight.
//   * Correctness is checked with a streaming "digest of digests": each chunk
//     is hashed (SHA-1 over its output records), and the per-chunk digests are
//     folded — in input order — into one top-level digest. The single-threaded
//     reference computes the same thing over the same chunk boundaries. Equal
//     top-level digests + equal kept-counts ⇒ byte-identical output, in order.
//
// Memory stays flat whether you run 10 thousand or 100 million records.

import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { compileFix, REJECT } from '../dist/index.js';

const WORKER_URL = fileURLToPath(new URL('./fix-worker.mjs', import.meta.url));

function* chunkRanges(total, chunkSize) {
  for (let start = 0; start < total; start += chunkSize) {
    yield [start, Math.min(start + chunkSize, total)];
  }
}

function buildChunk(makeRecord, start, end) {
  const recs = new Array(end - start);
  for (let i = start; i < end; i++) recs[i - start] = makeRecord(i);
  return recs;
}

// Single-threaded digest of one chunk — must match exactly what the worker does.
function chunkDigest(records, run) {
  const h = createHash('sha1');
  let kept = 0;
  for (const rec of records) {
    const r = run(rec);
    if (r === REJECT) continue;
    kept++;
    h.update(JSON.stringify(r));
  }
  return { kept, digest: h.digest('hex') };
}

export async function runDemo({ title, src, total, workers, chunkSize = 5000, makeRecord }) {
  console.log(title);
  console.log(`  records : ${total.toLocaleString()}`);
  console.log(`  workers : ${workers}`);
  console.log(`  chunk   : ${chunkSize.toLocaleString()} records  (memory stays bounded)\n`);

  // Sample peak resident set size across the whole run. worker_threads live in
  // this process, so process RSS covers the workers too.
  let peakRss = process.memoryUsage().rss;
  const sampler = setInterval(() => {
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
  }, 50);
  sampler.unref();
  const wallStart = performance.now();

  const run = compileFix(src);

  // Show one transformed record so it's clear what the script does.
  for (let i = 0; i < Math.min(total, 50); i++) {
    const out = run(makeRecord(i));
    if (out !== REJECT) {
      console.log(`sample input  #${i}: ${JSON.stringify(makeRecord(i))}`);
      console.log(`sample output #${i}: ${JSON.stringify(out)}\n`);
      break;
    }
  }

  // ---- single-threaded reference: streaming digest-of-digests -------------
  const t0 = performance.now();
  const refTop = createHash('sha1');
  let refKept = 0;
  for (const [start, end] of chunkRanges(total, chunkSize)) {
    const { kept, digest } = chunkDigest(buildChunk(makeRecord, start, end), run);
    refKept += kept;
    refTop.update(digest);
  }
  const refDigest = refTop.digest('hex');
  const singleMs = performance.now() - t0;
  console.log(
    `single-threaded: ${refKept.toLocaleString()} kept in ${(singleMs / 1000).toFixed(1)}s  ` +
      `digest ${refDigest.slice(0, 12)}…`,
  );

  // ---- parallel: persistent pool + backpressure + ordered combine ---------
  const ranges = [...chunkRanges(total, chunkSize)];
  const pool = Array.from({ length: workers }, () => new Worker(WORKER_URL, { workerData: { src } }));
  const parTop = createHash('sha1');
  const pending = new Map(); // chunk id -> {kept, digest} waiting to be combined in order
  let nextToDispatch = 0;
  let nextToCombine = 0;
  let parKept = 0;
  let completed = 0;

  const t1 = performance.now();
  await new Promise((resolve, reject) => {
    const dispatch = (worker) => {
      if (nextToDispatch >= ranges.length) return; // nothing left; worker goes idle
      const id = nextToDispatch++;
      const [start, end] = ranges[id];
      worker.postMessage({ id, records: buildChunk(makeRecord, start, end) });
    };

    const combineReady = () => {
      // Fold chunk digests into the top-level hash strictly in input order.
      while (pending.has(nextToCombine)) {
        const { kept, digest } = pending.get(nextToCombine);
        pending.delete(nextToCombine);
        parKept += kept;
        parTop.update(digest);
        nextToCombine++;
      }
    };

    if (ranges.length === 0) return resolve();
    for (const worker of pool) {
      worker.on('error', reject);
      worker.on('message', ({ id, kept, digest }) => {
        pending.set(id, { kept, digest });
        combineReady();
        if (++completed === ranges.length) resolve();
        else dispatch(worker); // hand this worker the next chunk → backpressure
      });
      dispatch(worker); // prime each worker with one chunk
    }
  });

  await Promise.all(pool.map((w) => w.terminate()));
  const parDigest = parTop.digest('hex');
  const parallelMs = performance.now() - t1;
  console.log(
    `multi-threaded : ${parKept.toLocaleString()} kept in ${(parallelMs / 1000).toFixed(1)}s  ` +
      `digest ${parDigest.slice(0, 12)}…  (${workers} workers)`,
  );
  console.log(`speedup        : ${(singleMs / parallelMs).toFixed(2)}x\n`);

  // ---- verdict ------------------------------------------------------------
  if (refDigest !== parDigest || refKept !== parKept) {
    console.error('✘ MISMATCH: parallel result differs from the single-threaded reference!');
    console.error(`  single: kept=${refKept} digest=${refDigest}`);
    console.error(`  multi : kept=${parKept} digest=${parDigest}`);
    process.exit(1);
  }
  console.log('✔ parallel result is identical to the single-threaded reference');
  console.log('  (same kept-count, same SHA-1 over all output records, in order).');
  console.log('  Memory stayed bounded — only a handful of chunks are ever in flight.');

  // ---- statistics ---------------------------------------------------------
  clearInterval(sampler);
  const wallMs = performance.now() - wallStart;
  const fmtRate = (ms) => Math.round(total / (ms / 1000)).toLocaleString();
  console.log('\nstatistics');
  console.log(`  wall clock      : ${(wallMs / 1000).toFixed(1)}s`);
  console.log(`  single-threaded : ${(singleMs / 1000).toFixed(1)}s  (${fmtRate(singleMs)} recs/sec)`);
  console.log(`  multi-threaded  : ${(parallelMs / 1000).toFixed(1)}s  (${fmtRate(parallelMs)} recs/sec, ${workers} workers)`);
  console.log(`  max memory (RSS): ${(peakRss / 1024 / 1024).toFixed(0)} MB`);
}
