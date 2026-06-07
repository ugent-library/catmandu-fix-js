// A subset of Catmandu Fix functions, ported to JS on top of the Path engine.
// Each fix is `(args) => (data) => data`, mirroring how Catmandu builds a
// fixer from a path plus arguments. Semantics follow Catmandu::Fix::* exactly
// (see the conformance tests, which are ported from Catmandu's own t/).

import { Path, isArray, isHash, KEEP, DROP } from './path.js';
import { marcmap, marcmapList, marcsubfields, marcForEachSub } from './marcmap.js';
import { escapeXML } from './xml_escape.js';
import { randomUUID } from 'node:crypto';
import { REJECT } from './signal.js';
import { sprintf, collapseHash, expandHash } from './util.js';
import { strptime, strftime } from './date.js';
import fs from 'node:fs';

type Data = any;
type Fixer = (data: Data) => Data;
type FixBuilder = (args: string[]) => Fixer;

// Structural deep clone of JSON-like data. Unlike structuredClone() this reads
// values through property access, so it also detaches a value read out of an
// immer copy-on-write draft (a Proxy, which structuredClone refuses to clone).
// Fix records are JSON-like (objects, arrays, primitives), which is exactly
// what this covers.
function clone<T>(v: T): T {
    if (v === null || typeof v !== 'object') return v;
    if (Array.isArray(v)) return v.map(clone) as unknown as T;
    const out: Record<string, any> = {};
    for (const k of Object.keys(v as object)) out[k] = clone((v as any)[k]);
    return out as T;
}

// Catmandu is_value: a defined scalar (string or number), not a ref.
function isValue(v: Data): boolean {
    return typeof v === 'string' || typeof v === 'number';
}

// Perl s/search/replace/g with $1 / ${1} interpolation -> JS replace.
function substituter(search: string, replace: string): (v: Data) => Data {
    let pattern = search;
    let flags = 'g';
    // Perl's \w/\W (and the data Catmandu feeds them) are Unicode-aware, so
    // accented letters like é/ö count as word characters; JS's \w/\W are
    // ASCII-only. When the pattern uses them, translate to Unicode property
    // classes and add the /u flag so e.g. replace_all(x, '\W+', '') keeps é/ö.
    if (/\\[wW]/.test(search)) {
        pattern = pattern.replace(/\\w/g, '[\\p{L}\\p{N}_]').replace(/\\W/g, '[^\\p{L}\\p{N}_]');
        flags = 'gu';
    }
    const re = new RegExp(pattern, flags);
    const js = replace.replace(/\$\{(\d+)\}/g, '$$$1'); // ${1} -> $1
    return (v: Data) => String(v).replace(re, js);
}

export const FIXES: Record<string, FixBuilder> = {
    // --- field creation / movement ---
    add_field: ([path, value]) => new Path(path!).creator(value ?? null),

    set_field: ([path, value]) => new Path(path!).setter(value ?? null),

    remove_field: ([path]) => new Path(path!).deleter(),

    copy_field: ([oldPath, newPath]) => {
        const getter = new Path(oldPath!).getter();
        const creator = new Path(newPath!).creator(undefined);
        return (data: Data) => {
            for (const v of getter(data).map(clone)) data = creator(data, v);
            return data;
        };
    },

    move_field: ([oldPath, newPath]) => {
        const getter = new Path(oldPath!).getter();
        const creator = new Path(newPath!).creator(undefined);
        const deleter = new Path(oldPath!).deleter();
        return (data: Data) => {
            for (const v of getter(data).map(clone)) data = creator(data, v);
            return deleter(data);
        };
    },

    // --- string transforms (only act on existing string values) ---
    upcase: ([path]) => new Path(path!).updater((v) => v.toUpperCase(), 'string'),
    downcase: ([path]) => new Path(path!).updater((v) => v.toLowerCase(), 'string'),
    capitalize: ([path]) => new Path(path!).updater((v) => {
        const s = v.toLowerCase();
        return s.charAt(0).toUpperCase() + s.slice(1);
    }, 'string'),

    trim: ([path, mode = 'whitespace']) => {
        const cb = mode === 'nonword'
            ? (v: string) => v.replace(/^\W+/u, '').replace(/\W+$/u, '')
            : mode === 'diacritics'
                ? (v: string) => v.normalize('NFKD').replace(/\p{Mn}/gu, '')
                : (v: string) => v.replace(/^\s+/u, '').replace(/\s+$/u, '');
        return new Path(path!).updater(cb, 'string');
    },

    prepend: ([path, str = '']) => new Path(path!).updater((v) => str + v, 'string'),
    append: ([path, str = '']) => new Path(path!).updater((v) => v + str, 'string'),

    replace_all: ([path, search, replace = '']) =>
        new Path(path!).updater(substituter(search!, replace), 'value'),

    // --- array <-> string ---
    join_field: ([path, sep = ' ']) =>
        new Path(path!).updater((v) => v.filter(isValue).join(sep), 'array'),

    split_field: ([path, sep = ' ']) => {
        const re = new RegExp(sep);
        return new Path(path!).updater((v) => String(v).split(re), 'value');
    },

    // --- paste: concatenate several fields/literals into one ---
    paste: (args) => {
        const target = args[0]!;
        let joinChar = ' ';
        const parts: Array<{ literal: string } | { getter: (d: Data) => Data[] }> = [];
        for (let i = 1; i < args.length; i++) {
            const a = args[i]!;
            if (a === 'join_char') { joinChar = args[i + 1] ?? ' '; break; }
            if (a.startsWith('~')) parts.push({ literal: a.slice(1) });
            else parts.push({ getter: new Path(a).getter() });
        }
        const creator = new Path(target).creator(undefined);
        return (data: Data) => {
            const vals: Data[] = [];
            for (const p of parts) {
                if ('literal' in p) vals.push(p.literal);
                else for (const v of p.getter(data)) if (isValue(v)) vals.push(v);
            }
            return creator(data, vals.join(joinChar));
        };
    },

    // --- MARC: reuse marcattacks' existing marcmap() for field extraction ---
    // marc_map(MARC_PATH, JSON_PATH, split:0|1, join:Str, value:Str)
    // Mirrors Catmandu::Fix::marc_map's emit loop: the result is a list of
    // values and each value is created at JSON_PATH (so a $append/numeric
    // target appends one element per value). Supports a /from-to substring.
    marc_map: (args) => {
        const marcPath0 = args[0]!;
        const jsonPath = args[1]!;
        const opts: Record<string, string | undefined> = {};
        for (let i = 2; i < args.length; i += 2) opts[args[i]!] = args[i + 1];
        const split = opts.split === '1' || opts.split === 'true';
        const joinChar = opts.join ?? '';   // Catmandu marc_map default join is empty
        const value = opts.value;

        // substring suffix, e.g. 008/35-37
        let marcPath = marcPath0;
        let from: number | undefined;
        let len = 1;
        const sub = /^(.*)\/(\d+)(?:-(\d+))?$/.exec(marcPath0);
        if (sub) { marcPath = sub[1]!; from = Number(sub[2]); if (sub[3] !== undefined) len = Number(sub[3]) - from + 1; }

        const p = new Path(jsonPath);
        const lastKey = p.keys.length ? p.keys[p.keys.length - 1]! : '';
        const forceArray = /^(\$.*|[0-9]+)$/.test(lastKey);
        const creator = p.creator(undefined);

        return (data: Data) => {
            const rec = data?.record;
            if (!isArray(rec)) return data;
            // split:1 keeps each matching subfield value as its own element;
            // otherwise marcmap() yields one entry per tag-matched field (an
            // empty string means the tag matched but no subfield did — Catmandu
            // drops those, so filter them out).
            let vals = split
                ? marcmapList(rec, marcPath)
                : marcmap(rec, marcPath, { join_char: joinChar }).filter((v) => v !== '');
            if (from !== undefined) {
                vals = vals.map((v) => (v.length > from! ? v.substr(from!, len) : undefined))
                    .filter((v): v is string => v !== undefined);
            }
            if (!vals.length) return data;

            let result: Data[];
            if (value !== undefined) result = [value];                 // value:Str -> constant when field exists
            else if (forceArray) result = vals;                        // append/numeric target: one element per value
            else if (split) result = [vals];                           // split: a single array value
            else result = [vals.join(joinChar)];                       // default: one joined string

            for (const v of result) data = creator(data, v);
            return data;
        };
    },

    // genid(PATH): create / overwrite each terminal slot with a fresh id.
    // A fresh id is generated per slot (so PATH.* yields a distinct id each).
    genid: ([path]) => new Path(path!).creator(() => `genid:${randomUUID()}`),

    // marc_remove(TAG): drop all MARC fields with the given tag.
    marc_remove: ([tag]) => (data: Data) => {
        if (data && isArray(data.record)) data.record = data.record.filter((r: string[]) => r[0] !== tag);
        return data;
    },

    // reject(): drop the current record / field (used inside marc_each etc.)
    reject: () => () => REJECT,

    // lookup(PATH, FILE, default:X, delete:1, sep_char:C): map values through a
    // 2-column CSV (key,val; no header). No match -> default / delete / keep.
    lookup: (args) => {
        const path = args[0]!;
        const file = args[1]!;
        const opts: Record<string, string | undefined> = {};
        for (let i = 2; i < args.length; i += 2) opts[args[i]!] = args[i + 1];
        const sep = opts.sep_char ?? ',';
        const dict = new Map<string, string>();
        for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
            if (!line) continue;
            const idx = line.indexOf(sep);
            if (idx < 0) continue;
            dict.set(line.slice(0, idx), line.slice(idx + sep.length));
        }
        const del = opts.delete === '1' || opts.delete === 'true';
        const hasDefault = 'default' in opts;
        return new Path(path).rewrite((v) => {
            if ((typeof v === 'string' || typeof v === 'number') && dict.has(String(v))) return dict.get(String(v));
            if (del) return DROP;
            if (hasDefault) return opts.default;
            return KEEP;
        });
    },

    // retain(PATH, ...): keep only the listed paths, drop everything else.
    retain: (paths) => {
        const getters = paths.map((p) => new Path(p).getter());
        const creators = paths.map((p) => new Path(p).creator(undefined));
        return (data: Data) => {
            const temp: Data = {};
            for (let i = 0; i < paths.length; i++) {
                for (const v of getters[i]!(data)) creators[i]!(temp, v);
            }
            if (isHash(data)) { for (const k of Object.keys(data)) delete data[k]; Object.assign(data, temp); }
            return data;
        };
    },

    // retain_field(PATH): delete every sibling of the final key under its parent.
    retain_field: ([path]) => {
        const p = new Path(path!);
        const key = p.keys.length ? p.keys[p.keys.length - 1]! : '';
        const keep = key.replace(/^['"]|['"]$/g, '');
        const parentGet = new Path(p.keys.slice(0, -1).join('.')).getter();
        return (data: Data) => {
            const parents = p.keys.length <= 1 ? [data] : parentGet(data);
            for (const c of parents) if (isHash(c)) for (const k of Object.keys(c)) if (k !== keep) delete c[k];
            return data;
        };
    },

    // substring(PATH, offset, [length], [replacement])
    substring: (args) => {
        const path = args[0]!;
        const off = Number(args[1]);
        const a2 = args[2];
        const a3 = args[3];
        return new Path(path).updater((v) => {
            const s = String(v);
            if (a3 !== undefined) {                       // replacement form
                const len = Number(a2);
                return s.slice(0, off) + a3 + s.slice(off + len);
            }
            if (a2 !== undefined) return s.substr(off, Number(a2));
            return s.substr(off);
        }, 'value');
    },

    // sort_field(PATH, uniq:1, reverse:1, numeric:1)
    sort_field: (args) => {
        const path = args[0]!;
        const opts: Record<string, string | undefined> = {};
        for (let i = 1; i < args.length; i += 2) opts[args[i]!] = args[i + 1];
        const doUniq = opts.uniq === '1';
        const rev = opts.reverse === '1';
        const num = opts.numeric === '1';
        return new Path(path).updater((arr) => {
            let defined = arr.filter((x: Data) => x !== undefined && x !== null);
            const hadUndef = defined.length !== arr.length;
            if (doUniq) { const seen = new Set(); defined = defined.filter((x: Data) => { const k = String(x); if (seen.has(k)) return false; seen.add(k); return true; }); }
            defined.sort(num ? (a: Data, b: Data) => Number(a) - Number(b) : (a: Data, b: Data) => String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
            if (rev) defined.reverse();
            if (hadUndef) defined.push(null);             // undefs collapse to one at the end (undef_position default last)
            return defined;
        }, 'array');
    },

    // uniq(PATH): strip duplicate values from an array (keep first occurrence).
    uniq: ([path]) => new Path(path!).updater((arr) => {
        const seen = new Set<string>();
        return arr.filter((x: Data) => { const k = String(x); if (seen.has(k)) return false; seen.add(k); return true; });
    }, 'array'),

    // vacuum(): recursively delete empty fields (null, blank string, [], {}).
    vacuum: () => (data: Data) => { vacuum(data); return data; },

    // format(PATH, SPEC): sprintf the value (string / array / hash) with SPEC.
    format: ([path, spec]) => new Path(path!).updater((v) => {
        if (isArray(v)) return sprintf(spec!, v);
        if (isHash(v)) return sprintf(spec!, Object.entries(v).flat());
        return sprintf(spec!, [v]);
    }),

    // count(PATH): replace an array/hash value with its size.
    count: ([path]) => new Path(path!).updater((v) =>
        isArray(v) ? v.length : isHash(v) ? Object.keys(v).length : v),

    // set_array(PATH, v...) / set_hash(PATH, k, v, ...): set to a fresh array/hash.
    set_array: (args) => new Path(args[0]!).setter(() => [...args.slice(1)]),
    set_hash: (args) => new Path(args[0]!).setter(() => {
        const o: Data = {}; const vs = args.slice(1);
        for (let i = 0; i < vs.length; i += 2) o[vs[i]!] = vs[i + 1];
        return o;
    }),

    // from_json(PATH) / to_json(PATH)
    from_json: ([path]) => new Path(path!).updater((v) => JSON.parse(v), 'string'),
    to_json: ([path]) => new Path(path!).updater((v) => JSON.stringify(v)),

    // rename(PATH, SEARCH, REPLACE): regex-rename hash keys under PATH (recursive).
    rename: ([path, search, replace]) => {
        const re = new RegExp(search!, 'g');
        const renamer = (node: Data): Data => {
            if (isHash(node)) {
                for (const old of Object.keys(node)) {
                    const val = node[old];
                    const nw = old.replace(re, replace!);
                    if (nw !== old) { delete node[old]; node[nw] = val; }
                    renamer(val);
                }
            } else if (isArray(node)) {
                for (const el of node) renamer(el);
            }
            return node;
        };
        return new Path(path!).updater(renamer);
    },

    // filter(PATH, REGEX, invert:1): keep array values (not) matching REGEX.
    filter: (args) => {
        const opts: Record<string, string | undefined> = {};
        for (let i = 2; i < args.length; i += 2) opts[args[i]!] = args[i + 1];
        const re = new RegExp(args[1]!);
        const invert = opts.invert === '1' || opts.invert === 'true';
        return new Path(args[0]!).updater((arr) =>
            arr.filter((x: Data) => re.test(String(x)) !== invert), 'array');
    },

    // flatten(PATH): recursively flatten nested arrays into one flat array.
    flatten: ([path]) => new Path(path!).updater((arr) => {
        let a = arr;
        while (a.some((x: Data) => isArray(x))) a = a.flatMap((x: Data) => (isArray(x) ? x : [x]));
        return a;
    }, 'array'),

    // collapse([sep]) / expand([sep]): whole-record flatten / nest (dot convention)
    collapse: (args) => {
        const sep = parseDashOpt(args, 'sep');
        return (data: Data) => {
            const c = collapseHash(data);
            if (sep === undefined || sep === '.') return c;
            const o: Data = {};
            for (const k of Object.keys(c)) o[k.replaceAll('.', sep)] = c[k];
            return o;
        };
    },
    expand: (args) => {
        const sep = parseDashOpt(args, 'sep');
        return (data: Data) => {
            if (sep === undefined || sep === '.') return expandHash(data);
            const o: Data = {};
            for (const k of Object.keys(data)) o[k.replaceAll(sep, '.')] = data[k];
            return expandHash(o);
        };
    },

    // parse_text(PATH, PATTERN): parse a string via regex -> hash (named
    // groups), array (numbered groups), or unchanged (no groups / no match).
    parse_text: ([path, pattern]) => {
        const re = new RegExp(pattern!);
        return new Path(path!).updater((v) => {
            const m = re.exec(String(v));
            if (!m) return v;
            if (m.groups && Object.keys(m.groups).length) return { ...m.groups };
            if (m.length > 1) return m.slice(1);
            return v;
        }, 'string');
    },

    // int(PATH): first integer in a string, else array/hash size, else 0.
    int: ([path]) => new Path(path!).updater((v) => {
        if (typeof v === 'number') return Math.trunc(v);
        if (typeof v === 'string') { const m = /([+-]?[0-9]+)/.exec(v); return m ? Number(m[1]) : 0; }
        if (isArray(v)) return v.length;
        if (isHash(v)) return Object.keys(v).length;
        return 0;
    }),

    // string(PATH): stringify a value / join array / join hash values (sorted keys).
    string: ([path]) => new Path(path!).updater((v) => {
        if (typeof v === 'string' || typeof v === 'number') return String(v);
        if (isArray(v) && v.every((x: Data) => typeof x === 'string' || typeof x === 'number')) return v.join('');
        if (isHash(v) && Object.values(v).every((x: Data) => typeof x === 'string' || typeof x === 'number')) {
            return Object.keys(v).sort().map((k) => v[k]).join('');
        }
        return '';
    }),

    // uri_encode / uri_decode (percent encoding, like Perl URI::Escape)
    uri_encode: ([path]) => new Path(path!).updater(
        (v) => encodeURIComponent(String(v)).replace(/[!*'()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()),
        'string'),
    uri_decode: ([path]) => new Path(path!).updater((v) => decodeURIComponent(String(v)), 'string'),

    // compact(PATH): drop null/undefined values from an array.
    compact: ([path]) => new Path(path!).updater(
        (arr) => arr.filter((x: Data) => x !== null && x !== undefined), 'array'),

    // expand_date([FIELD=date]): split a date value into year/month/day at root.
    expand_date: ([field]) => {
        const get = new Path(field ?? 'date').getter();
        return (data: Data) => {
            const v = get(data)[0];
            if (typeof v !== 'string') return data;
            const parts = v.split(/\D+/).filter((p) => p !== '');
            if (parts.length >= 1) data.year = parts[0];          // string
            if (parts.length >= 2) data.month = Number(parts[1]); // number
            if (parts.length >= 3) data.day = Number(parts[2]);   // number
            return data;
        };
    },

    // datetime_format(PATH, source_pattern:..., destination_pattern:..., delete:0|1):
    // reparse each value at PATH with the strptime source_pattern and re-emit it
    // with the strftime destination_pattern (defaults to source_pattern). Values
    // that don't match the source pattern are left untouched, or dropped when
    // delete:1. Dates are handled in UTC (Catmandu::Fix::Date's default).
    datetime_format: (args) => {
        const path = args[0]!;
        const opts: Record<string, string | undefined> = {};
        for (let i = 1; i < args.length; i += 2) opts[args[i]!] = args[i + 1];
        const src = opts.source_pattern;
        const dst = opts.destination_pattern ?? src;
        const del = opts.delete === '1' || opts.delete === 'true';
        return new Path(path).rewrite((v) => {
            if (!isValue(v) || src === undefined || dst === undefined) return del ? DROP : KEEP;
            const dt = strptime(src, String(v));
            if (dt === null) return del ? DROP : KEEP;
            return strftime(dst, dt);
        });
    },

    // marc_xml([PATH=record]): serialize the MARC record (the `record` array)
    // to a MARCXML `<marc:record>` string and store it at PATH (default
    // `record`, i.e. replace the array in place). Compact (no whitespace
    // between elements), using the `marc:` prefix and MARC21 slim namespace —
    // the same convention as the MARCXML exporter (src/output/xml.ts). Records
    // without a `record` array are left unchanged.
    marc_xml: ([path]) => {
        const target = new Path(path ?? 'record').creator(undefined);
        return (data: Data) => {
            const rec = data?.record;
            if (!isArray(rec)) return data;
            return target(data, recordToMarcXML(rec));
        };
    },

    // --- misc ---
    nothing: () => (data: Data) => data,
};

// Serialize a MARC record (rows of [tag, ind1, ind2, code, val, ...]) to a
// compact MARCXML <marc:record> element. The leader and control fields (00x)
// carry a bare value (subfield "_"); data fields carry coded subfields.
function recordToMarcXML(rec: string[][]): string {
    let out = '<marc:record xmlns:marc="http://www.loc.gov/MARC21/slim">';
    for (const row of rec) {
        const tag = row[0] ?? '';
        if (tag === 'FMT') continue;
        // Escape < > " ' & in element text too (forAttribute:true), matching
        // the MARC::File::XML output Catmandu produces.
        if (tag === 'LDR') {
            out += `<marc:leader>${escapeXML(marcsubfields(row, /.*/)[0], { forAttribute: true })}</marc:leader>`;
        } else if (/^00/.test(tag)) {
            out += `<marc:controlfield tag="${escapeXML(tag, { forAttribute: true })}">${escapeXML(marcsubfields(row, /.*/)[0], { forAttribute: true })}</marc:controlfield>`;
        } else {
            const ind1 = row[1] ?? ' ', ind2 = row[2] ?? ' ';
            out += `<marc:datafield tag="${escapeXML(tag, { forAttribute: true })}" ind1="${escapeXML(ind1, { forAttribute: true })}" ind2="${escapeXML(ind2, { forAttribute: true })}">`;
            marcForEachSub(row, (code, value) => {
                out += `<marc:subfield code="${escapeXML(code, { forAttribute: true })}">${escapeXML(value, { forAttribute: true })}</marc:subfield>`;
            });
            out += '</marc:datafield>';
        }
    }
    out += '</marc:record>';
    return out;
}

// parse a Catmandu-style "-sep => x" / "sep: x" option out of an arg list
function parseDashOpt(args: string[], name: string): string | undefined {
    for (let i = 0; i < args.length; i++) {
        if (args[i] === name || args[i] === `-${name}`) return args[i + 1];
    }
    return undefined;
}

function isEmpty(v: Data): boolean {
    return v === undefined || v === null
        || (typeof v === 'string' && !/\S/.test(v))
        || (isArray(v) && v.length === 0)
        || (isHash(v) && Object.keys(v).length === 0);
}

function vacuum(node: Data): void {
    if (isHash(node)) {
        for (const k of Object.keys(node)) {
            if (isEmpty(node[k])) delete node[k];
            else { vacuum(node[k]); if (isEmpty(node[k])) delete node[k]; }
        }
    } else if (isArray(node)) {
        for (let i = node.length - 1; i >= 0; i--) {
            if (isEmpty(node[i])) node.splice(i, 1);
            else { vacuum(node[i]); if (isEmpty(node[i])) node.splice(i, 1); }
        }
    }
}

export function buildFix(name: string, args: string[]): Fixer {
    const builder = FIXES[name];
    if (!builder) throw new Error(`unknown fix: ${name}`);
    return builder(args);
}
