// purity.mjs — a compiled fix is a pure function: it never mutates the record
// you pass in. That makes it safe to transform a batch while keeping the
// originals, or to apply a fix to a shared/reused object.
//
//   node examples/purity.mjs

import { compileFix } from '../dist/index.js';

const run = compileFix(`
  trim(title)
  upcase(title)
  copy_field(title, title_sort)
  downcase(title_sort)
`);

const originals = [
  { id: 1, title: '  The Hobbit  ', meta: { year: 1937 } },
  { id: 2, title: '  Dune  ', meta: { year: 1965 } },
];

const transformed = originals.map((rec) => run(rec));

console.log('transformed:');
for (const r of transformed) console.log('  ', JSON.stringify(r));

console.log('\noriginals — untouched:');
for (const r of originals) console.log('  ', JSON.stringify(r));

// Untouched subtrees are shared with the input by reference (structural
// sharing) — Fix only copies the fields it actually changes.
console.log('\ntransformed[0].meta === originals[0].meta ?', transformed[0].meta === originals[0].meta);

// The result is frozen, so it can't be mutated by accident.
console.log('result is frozen ?', Object.isFrozen(transformed[0]));
