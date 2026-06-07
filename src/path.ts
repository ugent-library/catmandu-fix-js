// A JavaScript port of Catmandu::Path::simple — the default Catmandu Fix path
// language. A path addresses fields in a JSON-like record and yields the four
// primitives the Fix functions are built from: getter / setter / creator /
// updater / deleter.
//
// Path syntax (see Catmandu::Path::simple):
//   foo.bar          nested hash keys
//   foo.0            array index (or hash key "0")
//   foo.*            every element of an array
//   foo.$first       first / last array element
//   foo.$last
//   foo.$append      append / prepend (create only)
//   foo.$prepend
//   'a.b'  "a b"     quoted keys (may contain dots/spaces); '' is the empty key
//   .                the empty path = the whole record (root)
//
// Keys are kept raw (quotes intact) so $append/* / numbers are recognised
// before unquoting; unquote() is applied only when a key is used as a hash key.

type Data = any;
type ValueFn = (current: Data, root: Data) => Data;

const SPECIAL = new Set(['*', '$first', '$last', '$append', '$prepend']);

// rewrite() callback verdicts: keep the value, drop the slot, or set a new value
export const KEEP: unique symbol = Symbol('keep');
export const DROP: unique symbol = Symbol('drop');

export function isHash(x: Data): boolean {
    return x !== null && typeof x === 'object' && !Array.isArray(x);
}
export function isArray(x: Data): boolean {
    return Array.isArray(x);
}
function isNatural(key: string): boolean {
    return /^(0|[1-9][0-9]*)$/.test(key);
}

export function unquote(str: string): string {
    if (str == null) return str;
    const m = /^'(.*)'$/.exec(str) ?? /^"(.*)"$/.exec(str);
    return m ? m[1]! : str;
}

export function splitPath(path: string): string[] {
    let p = path.trim();
    p = p.replace(/^\$[./]/, '');                 // strip a leading $. or $/
    if (p === '') return [];
    // split on unescaped . or / ; then drop the escaping backslash
    const parts = p.split(/(?<!\\)[./]/).map((s) => s.replace(/\\(?=[./])/g, ''));
    // Perl's split drops trailing empty fields (so "." -> [])
    while (parts.length && parts[parts.length - 1] === '') parts.pop();
    return parts;
}

export class Path {
    readonly keys: string[];
    constructor(path: string) {
        this.keys = splitPath(path);
    }

    // ---- navigation over EXISTING structure (no creation) ----
    // calls cb(value) for every terminal match of `keys` within node
    private static navigate(node: Data, keys: string[], cb: (v: Data) => void): void {
        if (keys.length === 0) { cb(node); return; }
        const key = keys[0]!;
        const rest = keys.slice(1);
        if (isNatural(key)) {
            const uq = unquote(key);
            if (isHash(node) && uq in node) Path.navigate(node[uq], rest, cb);
            else if (isArray(node) && node.length > Number(key)) Path.navigate(node[Number(key)], rest, cb);
        } else if (key === '*') {
            if (isArray(node)) for (const v of node) Path.navigate(v, rest, cb);
        } else if (key === '$first') {
            if (isArray(node) && node.length) Path.navigate(node[0], rest, cb);
        } else if (key === '$last') {
            if (isArray(node) && node.length) Path.navigate(node[node.length - 1], rest, cb);
        } else {
            const uq = unquote(key);
            if (isHash(node) && uq in node) Path.navigate(node[uq], rest, cb);
        }
    }

    getter(): (data: Data) => Data[] {
        const keys = this.keys;
        return (data: Data) => {
            const vals: Data[] = [];
            Path.navigate(data, keys, (v) => vals.push(v));
            return vals;
        };
    }

    // ---- set the final key on already-existing containers ----
    private static setKey(container: Data, key: string, val: Data): void {
        if (isNatural(key)) {
            if (isHash(container)) container[unquote(key)] = val;
            else if (isArray(container)) container[Number(key)] = val;
        } else if (key === '$first') {
            if (isArray(container)) container[0] = val;
        } else if (key === '$last') {
            if (isArray(container) && container.length) container[container.length - 1] = val;
        } else if (key === '$prepend') {
            if (isArray(container)) container.unshift(val);
        } else if (key === '$append') {
            if (isArray(container)) container.push(val);
        } else if (key === '*') {
            if (isArray(container)) for (let i = 0; i < container.length; i++) container[i] = val;
        } else {
            if (isHash(container)) container[unquote(key)] = val;
        }
    }

    setter(value: Data | ValueFn): (data: Data, val?: Data) => Data {
        const keys = this.keys;
        return (data: Data, val?: Data) => {
            if (keys.length === 0) {
                return typeof value === 'function' ? (value as ValueFn)(data, data)
                    : value !== undefined ? value : val;
            }
            const key = keys[keys.length - 1]!;
            const parent = keys.slice(0, -1);
            Path.navigate(data, parent, (container) => {
                const v = typeof value === 'function' ? (value as ValueFn)(container, data)
                    : value !== undefined ? value : val;
                Path.setKey(container, key, v);
            });
            return data;
        };
    }

    deleter(): (data: Data) => Data {
        const keys = this.keys;
        return (data: Data) => {
            if (keys.length === 0) return data;
            const key = keys[keys.length - 1]!;
            const parent = keys.slice(0, -1);
            Path.navigate(data, parent, (container) => {
                if (isNatural(key)) {
                    const uq = unquote(key);
                    if (isHash(container) && uq in container) delete container[uq];
                    else if (isArray(container) && container.length > Number(key)) container.splice(Number(key), 1);
                } else if (key === '$first') {
                    if (isArray(container) && container.length) container.splice(0, 1);
                } else if (key === '$last') {
                    if (isArray(container) && container.length) container.splice(container.length - 1, 1);
                } else if (key === '*') {
                    if (isArray(container)) container.splice(0, container.length);
                } else {
                    if (isHash(container)) delete container[unquote(key)];
                }
            });
            return data;
        };
    }

    // ---- update EXISTING values in place (optionally type-guarded) ----
    updater(fn: (v: Data) => Data, ifType?: 'string' | 'array' | 'value'): (data: Data) => Data {
        const keys = this.keys;
        const match = (v: Data) =>
            ifType === undefined ? true
                : ifType === 'string' ? typeof v === 'string'
                    : ifType === 'array' ? isArray(v)
                        : (typeof v === 'string' || typeof v === 'number'); // 'value'
        const upd = (container: Data, key: string) => {
            const at = (read: () => Data, write: (nv: Data) => void) => {
                const v = read();
                if (match(v)) write(fn(v));
            };
            if (key === '*') {
                if (isArray(container)) for (let i = 0; i < container.length; i++) at(() => container[i], (nv) => (container[i] = nv));
            } else if (key === '$first') {
                if (isArray(container) && container.length) at(() => container[0], (nv) => (container[0] = nv));
            } else if (key === '$last') {
                if (isArray(container) && container.length) { const i = container.length - 1; at(() => container[i], (nv) => (container[i] = nv)); }
            } else if (isNatural(key)) {
                const uq = unquote(key);
                if (isHash(container) && uq in container) at(() => container[uq], (nv) => (container[uq] = nv));
                else if (isArray(container) && container.length > Number(key)) { const i = Number(key); at(() => container[i], (nv) => (container[i] = nv)); }
            } else {
                const uq = unquote(key);
                if (isHash(container) && uq in container) at(() => container[uq], (nv) => (container[uq] = nv));
            }
        };
        return (data: Data) => {
            if (keys.length === 0) return data;
            const key = keys[keys.length - 1]!;
            const parent = keys.slice(0, -1);
            Path.navigate(data, parent, (container) => upd(container, key));
            return data;
        };
    }

    // ---- create intermediate path and set the terminal value ----
    private static create(node: Data, keys: string[], makeVal: (cur: Data) => Data): Data {
        if (keys.length === 0) return makeVal(node);
        const key = keys[0]!;
        const rest = keys.slice(1);
        if (isNatural(key)) {
            if (isHash(node)) { node[unquote(key)] = Path.create(node[unquote(key)], rest, makeVal); return node; }
            const arr = isArray(node) ? node : node == null ? [] : node;
            if (!isArray(arr)) return node;
            arr[Number(key)] = Path.create(arr[Number(key)], rest, makeVal);
            return arr;
        }
        if (key === '*') {
            if (isArray(node)) for (let i = node.length - 1; i >= 0; i--) node[i] = Path.create(node[i], rest, makeVal);
            return node;
        }
        if (SPECIAL.has(key)) { // $first/$last/$append/$prepend
            if (!(node == null || isArray(node))) return node; // is_maybe_array_ref
            const arr = node ?? [];
            if (key === '$first') {
                arr[0] = Path.create(arr[0], rest, makeVal);
            } else if (key === '$last') {
                if (arr.length) arr[arr.length - 1] = Path.create(arr[arr.length - 1], rest, makeVal);
                else arr[0] = Path.create(arr[0], rest, makeVal);
            } else if (key === '$prepend') {
                if (arr.length) arr.unshift(undefined);
                arr[0] = Path.create(arr[0], rest, makeVal);
            } else { // $append
                const idx = arr.length;
                arr[idx] = Path.create(arr[idx], rest, makeVal);
            }
            return arr;
        }
        // plain hash key
        if (!(node == null || isHash(node))) return node; // is_maybe_hash_ref
        const obj = node ?? {};
        obj[unquote(key)] = Path.create(obj[unquote(key)], rest, makeVal);
        return obj;
    }

    // rewrite each existing terminal value: fn returns KEEP (no change),
    // DROP (remove the slot), or any other value to set. Handles deletion of
    // array elements (*, index, $first/$last) and hash keys.
    rewrite(fn: (v: Data) => Data): (data: Data) => Data {
        const keys = this.keys;
        const apply = (container: Data, key: string) => {
            if (key === '*') {
                if (!isArray(container)) return;
                const out: Data[] = [];
                for (const el of container) {
                    const r = fn(el);
                    if (r === DROP) continue;
                    out.push(r === KEEP ? el : r);
                }
                container.splice(0, container.length, ...out);
            } else if (key === '$first' || key === '$last' || /^(0|[1-9][0-9]*)$/.test(key)) {
                const idx = key === '$first' ? 0 : key === '$last' ? container?.length - 1 : Number(key);
                if (isArray(container) && idx >= 0 && idx < container.length) {
                    const r = fn(container[idx]);
                    if (r === DROP) container.splice(idx, 1);
                    else if (r !== KEEP) container[idx] = r;
                } else if (isHash(container) && unquote(key) in container) {
                    const uq = unquote(key); const r = fn(container[uq]);
                    if (r === DROP) delete container[uq]; else if (r !== KEEP) container[uq] = r;
                }
            } else {
                const uq = unquote(key);
                if (isHash(container) && uq in container) {
                    const r = fn(container[uq]);
                    if (r === DROP) delete container[uq]; else if (r !== KEEP) container[uq] = r;
                }
            }
        };
        return (data: Data) => {
            if (keys.length === 0) return data;
            const key = keys[keys.length - 1]!;
            Path.navigate(data, keys.slice(0, -1), (c) => apply(c, key));
            return data;
        };
    }

    creator(value: Data | ValueFn): (data: Data, val?: Data) => Data {
        const keys = this.keys;
        return (data: Data, val?: Data) =>
            Path.create(data, keys, (cur) =>
                typeof value === 'function' ? (value as ValueFn)(cur, data)
                    : value !== undefined ? value : val);
    }
}
