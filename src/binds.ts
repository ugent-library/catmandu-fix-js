// Catmandu Fix binds: the `do BIND(...) ... end` construct that wraps a block
// of fixes and controls how they are applied. A subset — `list` and `with`
// (descend into a path), `each` (loop over array/hash entries), `marc_each`
// (loop over MARC fields), and `identity`.
//
// Bind contract (see Catmandu::Fix::Bind): unit(data) seeds the bound value,
// then the wrapped block is applied to it. `do` returns the original record;
// `doset` returns the bound result.

import { Path, isHash, isArray } from './path.js';
import { REJECT } from './signal.js';

type Data = any;
type Runner = (data: Data) => Data;

// structured field hash for marc_each's `var` (tag/ind1/ind2/subfields)
function fieldToHash(row: string[]): Data {
    const subfields: Data[] = [];
    for (let i = 3; i < row.length; i += 2) subfields.push({ [row[i]!]: row[i + 1] });
    return { tag: row[0], ind1: row[1], ind2: row[2], subfields };
}

function parseOpts(args: string[]): Record<string, string> {
    const o: Record<string, string> = {};
    for (let i = 0; i < args.length; i += 2) if (args[i] !== undefined) o[args[i]!] = args[i + 1] ?? '';
    return o;
}

export function buildBind(name: string, args: string[], body: Runner, doset: boolean): Runner {
    const opts = parseOpts(args);

    if (name === 'list') {
        const pathGet = opts.path !== undefined ? new Path(opts.path).getter() : undefined;
        const varName = opts.var;
        return (data: Data) => {
            const root = data;
            const mvar = pathGet ? pathGet(data)[0] : data;
            let result: Data = mvar;
            if (isHash(mvar)) {
                result = body(mvar);
            } else if (isArray(mvar)) {
                for (let i = 0; i < mvar.length; i++) {
                    if (varName !== undefined) {
                        root[varName] = mvar[i];
                        body(root);
                        delete root[varName];
                    } else {
                        mvar[i] = body(mvar[i]);
                    }
                }
                result = mvar;
            } else {
                result = []; // zero
            }
            return doset ? result : root;
        };
    }

    // with: descend into `path` and run the block with the matched value as
    // the record root — each element of an array, or the hash itself. Scalars
    // (or a missing path) leave the record untouched. The idiomatic way to
    // operate on a sub-structure in place. `path` may be named (`path:p`) or
    // given as the first positional argument (`with(p)`).
    if (name === 'with') {
        const pathStr = opts.path !== undefined ? opts.path : args[0];
        const pathGet = pathStr !== undefined ? new Path(pathStr).getter() : undefined;
        return (data: Data) => {
            const root = data;
            const mvar = pathGet ? pathGet(data)[0] : data;
            if (isArray(mvar)) {
                for (let i = 0; i < mvar.length; i++) mvar[i] = body(mvar[i]);
            } else if (isHash(mvar)) {
                body(mvar);
            }
            return doset ? mvar : root;
        };
    }

    // each: loop over the entries of the array or hash at `path`, exposing each
    // entry to the block via `var` as { index, value } (arrays) or
    // { key, value } (hashes). The block runs on the root record, so it can
    // read var.key/var.value and build new fields elsewhere. Without `var` the
    // block simply runs once per entry.
    if (name === 'each') {
        const pathStr = opts.path !== undefined ? opts.path : args[0];
        const pathGet = pathStr !== undefined ? new Path(pathStr).getter() : undefined;
        const varName = opts.var;
        return (data: Data) => {
            const root = data;
            const matches = pathGet ? pathGet(data) : [data];
            const run = (pair: Data) => {
                if (varName !== undefined) {
                    root[varName] = pair;
                    body(root);
                    delete root[varName];
                } else {
                    body(root);
                }
            };
            for (const value of matches) {
                if (isArray(value)) {
                    for (let idx = 0; idx < value.length; idx++) run({ index: idx, value: value[idx] });
                } else if (isHash(value)) {
                    for (const key of Object.keys(value)) run({ key, value: value[key] });
                }
            }
            return doset ? matches : root;
        };
    }

    // marc_each: iterate each MARC field; run the block on a record holding
    // just that field; accumulate the resulting fields. reject() drops a field.
    if (name === 'marc_each') {
        const varName = opts.var;
        return (data: Data) => {
            const rows: string[][] = (data && isArray(data.record)) ? data.record : [];
            const out: string[][] = [];
            for (const row of rows) {
                data.record = [row];
                if (varName !== undefined) data[varName] = fieldToHash(row);
                const fixed = body(data);
                if (fixed !== REJECT && fixed && isArray(fixed.record)) out.push(...fixed.record);
                if (varName !== undefined) delete data[varName];
            }
            data.record = out;
            return data;
        };
    }

    // identity (and any unknown bind): just run the block on the record
    return (data: Data) => {
        const r = body(data);
        return doset ? r : data;
    };
}
