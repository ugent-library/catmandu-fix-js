// Catmandu Fix conditions, used by if/unless blocks. Each returns a predicate
// over the record. (A subset — the common ones.)

import { Path } from './path.js';

type Data = any;
type Cond = (data: Data) => boolean;

// subfield values addressed by a MARC path (tag + subcodes; tag may be ***)
function marcValues(data: Data, mp: string): Data[] {
    const rec = data?.record;
    if (!Array.isArray(rec)) return [];
    const tag = mp.slice(0, 3);
    const subs = mp.slice(3).replace(/\$/g, '');
    const out: Data[] = [];
    for (const row of rec) {
        if (tag !== '***' && row[0] !== tag) continue;
        for (let i = 3; i < row.length; i += 2) {
            if (subs === '' || subs.includes(row[i])) out.push(row[i + 1]);
        }
    }
    return out;
}

// >=1 value present and ALL pass the test (Catmandu Builder::Simple all_u)
function all(getter: (d: Data) => Data[], test: (x: Data) => boolean): Cond {
    return (d) => { const v = getter(d); return v.length > 0 && v.every(test); };
}

export function buildCondition(name: string, args: string[]): Cond {
    const path = args[0] !== undefined ? new Path(args[0]).getter() : () => [];
    const arg = args[1];

    switch (name) {
        case 'exists':
            return (d) => path(d).length > 0;
        case 'all_match': {
            const re = new RegExp(arg!);
            return (d) => { const v = path(d); return v.length > 0 && v.every((x) => re.test(String(x))); };
        }
        case 'any_match': {
            const re = new RegExp(arg!);
            return (d) => path(d).some((x) => re.test(String(x)));
        }
        case 'all_equal':
            return (d) => { const v = path(d); return v.length > 0 && v.every((x) => String(x) === arg); };
        case 'any_equal':
            return (d) => path(d).some((x) => String(x) === arg);
        case 'is_string':
            return (d) => { const v = path(d); return v.length > 0 && v.every((x) => typeof x === 'string'); };
        case 'is_array':
            return (d) => { const v = path(d); return v.length > 0 && v.every((x) => Array.isArray(x)); };
        // "Simple" conditions: true iff there is >=1 value and ALL values pass
        // (matches Catmandu's Builder::Simple all_u semantics).
        case 'is_number':
            return all(path, (x) => typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !isNaN(Number(x))));
        case 'is_object':
            return all(path, (x) => x !== null && typeof x === 'object' && !Array.isArray(x));
        case 'is_null':
            return all(path, (x) => x === null || x === undefined);
        case 'greater_than': {
            const n = parseInt(arg!, 10);
            return all(path, (x) => (typeof x === 'number' || typeof x === 'string') && Number(x) > n);
        }
        case 'less_than': {
            const n = parseInt(arg!, 10);
            return all(path, (x) => (typeof x === 'number' || typeof x === 'string') && Number(x) < n);
        }
        case 'is_true':
        case 'is_false': {
            const strict = args.some((a, i) => a === 'strict' && (args[i + 1] === '1' || args[i + 1] === 'true'));
            const want = name === 'is_true';
            return all(path, (x) => strict
                ? x === want
                : (x === want || (typeof x === 'number' && x === (want ? 1 : 0)) || (typeof x === 'string' && x === (want ? 'true' : 'false'))));
        }
        case 'in': {
            const get2 = new Path(args[1] ?? '').getter();
            const inOne = (a: Data, b: Data): boolean => {
                if (a == null && b == null) return true;
                if (a == null || b == null) return false;
                if (Array.isArray(b)) return b.some((x) => String(x) === String(a));
                if (b !== null && typeof b === 'object') return String(a) in b;
                return String(a) === String(b);
            };
            return (d) => {
                const a = path(d); const b = get2(d);
                if (!a.length || !b.length || a.length !== b.length) return false;
                for (let i = 0; i < a.length; i++) if (!inOne(a[i], b[i])) return false;
                return true;
            };
        }
        case 'marc_match':
        case 'marc_any_match':
            return (d) => marcValues(d, args[0]!).some((v) => new RegExp(arg!).test(String(v)));
        case 'marc_all_match': {
            const re = new RegExp(arg!);
            return (d) => { const v = marcValues(d, args[0]!); return v.length > 0 && v.every((x) => re.test(String(x))); };
        }
        case 'marc_has':
            return (d) => Array.isArray(d?.record) && d.record.some((row: string[]) => row[0] === args[0]);
        case 'marc_has_many':
            return (d) => Array.isArray(d?.record) && d.record.filter((row: string[]) => row[0] === args[0]).length > 1;
        default:
            throw new Error(`unknown condition: ${name}`);
    }
}
