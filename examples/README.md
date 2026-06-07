# Examples

## Purity — fixes don't mutate your records

```
node examples/purity.mjs
```

`compileFix(src)` returns a pure `(record) => record` function: it leaves the
input untouched and returns a new, frozen record. [`purity.mjs`](./purity.mjs)
transforms a batch while keeping the originals intact, and shows that untouched
subtrees are shared with the input by reference (structural sharing). See
[Pure & immutable](../README.md#pure--immutable) in the top-level README.

## Running Fix across worker threads

```
node examples/multithreaded.mjs [recordCount] [workerCount]
```

[`multithreaded.mjs`](./multithreaded.mjs) fans a compiled Fix out across a pool
of `worker_threads`. It's a single self-contained file (main thread + worker,
selected by `isMainThread`).

Nothing is shared between threads:

- Each worker receives the Fix **source string** and compiles its own runner —
  functions can't be sent across threads.
- Records travel by message; `postMessage` makes a structured-clone copy, so each
  worker only ever touches its own records.
- Compiled fixes are pure (above), so there's no cross-record state to race on.
