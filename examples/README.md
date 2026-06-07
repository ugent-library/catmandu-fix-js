# Examples

## Running Fix multithreaded

```
node examples/multithreaded.mjs       [recordCount] [workerCount] [chunkSize]
node examples/multithreaded-marc.mjs  [recordCount] [workerCount] [chunkSize]
```

These demos prove that a compiled Fix script can be run across many threads in
parallel with no risk of data races or corrupted output. Each:

1. transforms a deterministic dataset **single-threaded** to get a reference,
2. transforms the same dataset across a pool of `worker_threads`, each
   compiling the **same Fix script** independently, then
3. asserts the parallel result is **identical** to the reference — same
   kept-count and the same SHA-1 taken over every output record, in order.

```
$ node examples/multithreaded-marc.mjs 1000000
catmandu-fix-js MARC multithreaded demo
  records : 1,000,000
  workers : 8
  chunk   : 5,000 records  (memory stays bounded)

sample input  #0: {"id":0,"record":[["LDR"," "," ","_", ...]]}
sample output #0: {"id":0,"record":[...],"title":"Title 0", ...,"format":"marc"}

single-threaded: 1,000,000 kept in 9.1s  digest a989c0310c56…
multi-threaded : 1,000,000 kept in 3.6s  digest a989c0310c56…  (8 workers)
speedup        : 2.55x

✔ parallel result is identical to the single-threaded reference
  (same kept-count, same SHA-1 over all output records, in order).
```

It scales to arbitrary record counts — memory stays flat (~1.5 GB peak, mostly
the 8 worker isolates) whether you run 200 thousand or 5 million:

```
node examples/multithreaded-marc.mjs 5000000
```

### Files

- [`multithreaded.mjs`](./multithreaded.mjs) — generic-record demo (entry point)
- [`multithreaded-marc.mjs`](./multithreaded-marc.mjs) — MARC demo (entry point)
- [`lib.mjs`](./lib.mjs) — shared driver: the bounded pool + verification
- [`fix-worker.mjs`](./fix-worker.mjs) — the worker body

### Why it stays memory-bounded

A naive demo (load the whole dataset, hand each worker a giant shard, ship all
transformed records back, hold them in one array) runs out of heap in the
millions — the main thread OOMs **deserializing** the result messages, which
has nothing to do with thread-safety. These demos avoid that:

- **Records are generated lazily, one chunk at a time** — the full dataset is
  never resident.
- **A persistent worker pool with backpressure** — workers are primed with one
  chunk each and only handed the next when they finish, so at most ~poolSize
  chunks are ever in flight.
- **Workers return a digest, not records** — each worker folds its chunk's
  output into a SHA-1 and returns only `{id, kept, digest}`. The main thread
  folds the per-chunk digests, in input order, into one top-level digest and
  compares it to the single-threaded reference. Equal digests + equal counts ⇒
  byte-identical output, in order, with O(1) memory.

## Why Fix is thread-safe

`compileFix(src)` parses and builds **once** and returns a pure
`(record) => record` function. The thread-safety guarantee rests on a few
properties of that function:

- **No cross-record shared state.** The compiled chain holds only its own
  immutable configuration (paths, literals, sub-runners). It reads and writes
  *the record it was handed* and nothing else. Two records can be processed in
  any order, or simultaneously on different threads, without interfering.

- **Records are not shared between threads.** In Node, `worker_threads`
  communicate by message passing; `postMessage` deep-copies via the structured
  clone algorithm. Each worker mutates its **own** copy of a record, so the
  in-place updates that Fix setters perform (`Catmandu::Path::simple`
  semantics) stay confined to one thread.

- **Functions don't cross the boundary anyway.** You can't ship a compiled
  runner to another thread — functions aren't cloneable. You ship the harmless
  Fix **source string** and each worker compiles its own runner. There is
  literally no shared object to race on.

- **The one module-level cache is benign.** `marc_map`/`marc_match` memoize
  parsed find-paths in a `Map` keyed by the find string, storing
  derived-immutable values (a tag name + a non-global, stateless `RegExp`).
  Each worker thread loads its own module instance, so the cache isn't even
  shared across threads; and within a thread, JavaScript's run-to-completion
  model means a synchronous transform is never preempted mid-call, so
  concurrent *async* tasks can't observe a half-written cache entry either.

- **Deterministic fixes are deterministic.** The demos use only deterministic
  fixes, which is why single- and multi-threaded outputs match exactly. The
  inherently non-deterministic ones — `genid` (random UUID) and `lookup`
  (reads a file) — are still thread-safe, but their *output* naturally varies
  (`genid`) or depends on an external file (`lookup`), so don't expect a
  bit-identical match when those are in play.
