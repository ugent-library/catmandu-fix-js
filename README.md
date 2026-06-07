# catmandu-fix-js

A JavaScript / TypeScript implementation of the **[Catmandu Fix language](https://github.com/LibreCat/Catmandu/wiki/Fix-language)** — a small declarative DSL for transforming JSON-like records. Fix is to JSON what XSLT is to XML.

The reference implementation of Fix is the Perl [LibreCat/Catmandu](https://github.com/LibreCat/Catmandu) toolkit. This package is a faithful, dependency-free port of a useful subset of that language, compiled to plain JavaScript functions so it can be embedded in any Node.js project. Semantics follow `Catmandu::Fix::*` exactly — the test suite is ported from Catmandu's own `t/`.

It also ships the MARC fixes (`Catmandu::MARC`-style `marc_map`, `marc_each`, …), operating on the standard MARC-in-JSON record representation.

## Installation

This package is not published to npm. Install it directly from the
[Codeberg repository](https://codeberg.org/phochste/catmandu-fix-js):

```
npm install git+https://codeberg.org/phochste/catmandu-fix-js.git
```

To pin a specific version, append a tag, branch, or commit:

```
npm install git+https://codeberg.org/phochste/catmandu-fix-js.git#v0.1.0
```

Or add it to your `package.json` directly:

```json
{
  "dependencies": {
    "catmandu-fix-js": "git+https://codeberg.org/phochste/catmandu-fix-js.git"
  }
}
```

The package's `prepare` script builds the TypeScript sources to `dist/` on
install, so no separate build step is required.

## Quick start

```js
import { compileFix, REJECT } from 'catmandu-fix-js';

// Parse + compile a Fix script ONCE into a record -> record function.
const run = compileFix(`
  upcase(title)
  add_field(type, Book)
  if exists(deleted)
    reject()
  end
`);

run({ title: 'hello' });
// => { title: 'HELLO', type: 'Book' }

run({ title: 'gone', deleted: 1 }) === REJECT;
// => true   (the record was dropped by reject())
```

`compileFix(src)` returns a synchronous `(record) => record` function. Parse and
build happen once; the returned function just runs the compiled chain per
record, so it is cheap to call in a hot loop or stream.

A Fix script may be passed inline (as above) or read from a `.fix` file with
your own `fs.readFileSync`.

## Streaming

The function is a pure record-to-record transform, so wrapping it in a Node
stream is trivial:

```js
import { Transform } from 'node:stream';
import { compileFix, REJECT } from 'catmandu-fix-js';

function fixStream(src) {
  const fix = compileFix(src);
  return new Transform({
    objectMode: true,
    transform(record, _enc, cb) {
      const out = fix(record);
      if (out === REJECT) cb();          // dropped record
      else cb(null, out);
    },
  });
}
```

## Thread safe

The Javascript library is thread safe and can be run with many parallel workers. See the examples folder for demonstrations how to parse JSON and MARC data using multiple workers. On an off the shelf laptop (8 x AMD Ryzen 3 ; 16 RAM ; Ubuntu 24.04) speeds up to a few O(100.000) records per second where measured using a sample of small synthetic MARC records.

## Custom fixes

`FIXES` is the fix registry; add your own builder (an `(args) => (data) => data`
function) before compiling:

```js
import { FIXES, compileFix } from 'catmandu-fix-js';
import { Path } from 'catmandu-fix-js';

FIXES.shout = ([path]) =>
  new Path(path).updater((v) => v.toUpperCase() + '!', 'string');

compileFix('shout(title)')({ title: 'hi' });   // => { title: 'HI!' }
```

The low-level building blocks are exported too: `Path` (the
`Catmandu::Path::simple` engine — `getter`/`setter`/`creator`/`updater`/`deleter`/`rewrite`),
`parseFix`, `buildFix`, `buildCondition`, `buildBind`, and the `REJECT` sentinel.

## Supported Fix functions

**Fields:** `add_field` · `set_field` · `remove_field` · `copy_field` · `move_field` · `retain` · `retain_field` · `rename`

**Strings:** `upcase` · `downcase` · `capitalize` · `trim` · `prepend` · `append` · `replace_all` · `substring` · `format` · `paste` · `parse_text` · `uri_encode` · `uri_decode`

**Arrays / structure:** `split_field` · `join_field` · `sort_field` · `uniq` · `filter` · `flatten` · `compact` · `count` · `set_array` · `set_hash` · `collapse` · `expand` · `vacuum`

**Types / JSON:** `int` · `string` · `from_json` · `to_json`

**Dates:** `expand_date` · `datetime_format`

**Lookups / ids:** `lookup` · `genid`

**MARC:** `marc_map` · `marc_remove` · `marc_xml`

**Control:** `reject` · `nothing`

### Conditions (`if` / `unless` … `[else]` … `end`)

`exists` · `all_match` · `any_match` · `all_equal` · `any_equal` · `is_string` · `is_array` · `is_number` · `is_object` · `is_null` · `is_true` · `is_false` · `greater_than` · `less_than` · `in` · `marc_match` · `marc_any_match` · `marc_all_match` · `marc_has` · `marc_has_many`

### Binds (`do` / `doset` … `end`)

`list` · `with` · `each` · `marc_each` · `identity`

## Paths

Field paths follow `Catmandu::Path::simple`:

| Path            | Meaning                                  |
|-----------------|------------------------------------------|
| `foo.bar`       | nested hash keys                         |
| `foo.0`         | array index (or hash key `"0"`)          |
| `foo.*`         | every element of an array                |
| `foo.$first` / `foo.$last`     | first / last array element  |
| `foo.$append` / `foo.$prepend` | append / prepend (create only) |
| `'a.b'` / `"a b"` | quoted key (may contain dots/spaces)   |
| `.`             | the whole record (root)                  |

## MARC records

The MARC fixes and conditions operate on the standard Catmandu MARC-in-JSON
representation: a record carries a `record` field that is an array of field
rows, each `[tag, ind1, ind2, code, value, code, value, …]`. The leader is the
row with tag `LDR`. For example:

```js
const rec = {
  record: [
    ['LDR', ' ', ' ', '_', '00000nam a2200000 a 4500'],
    ['245', '1', '0', 'a', 'The title', 'b', 'a subtitle'],
  ],
};

compileFix('marc_map(245a, title)')(rec);
// => rec.title === 'The title'
```

## License

[MIT](./LICENSE) © Patrick Hochstenbach

Fix is a language of the [LibreCat](https://librecat.org/) project; this is an
independent JavaScript port and is not affiliated with or endorsed by LibreCat.
