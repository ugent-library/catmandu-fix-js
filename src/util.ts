// Helpers for fixes that need more than the path engine: a Perl-ish sprintf
// (format), and the collapse/expand hash transforms (TT2 dot convention).

import { Path, isHash, isArray } from './path.js';

type Data = any;

// A subset of Perl/C sprintf: flags - + space 0 #, width, .precision, and
// conversions d i u s f e g x X o b c %.
export function sprintf(fmt: string, args: Data[]): string {
    let idx = 0;
    return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?([%a-zA-Z])/g, (_m, flags: string, widthS, precS, conv: string) => {
        if (conv === '%') return '%';
        const arg = args[idx++];
        const width = widthS ? Number(widthS) : 0;
        const prec = precS !== undefined ? Number(precS) : undefined;
        const left = flags.includes('-');
        const zero = flags.includes('0') && !left;
        const signOf = (n: number) => (n < 0 ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '');
        let sign = '';
        let body = '';
        switch (conv) {
            case 'd': case 'i': case 'u': {
                const n = Math.trunc(Number(arg)) || 0; sign = signOf(n); body = Math.abs(n).toString();
                if (prec !== undefined) body = body.padStart(prec, '0');
                break;
            }
            case 'f': case 'F': {
                const n = Number(arg) || 0; sign = signOf(n); body = Math.abs(n).toFixed(prec === undefined ? 6 : prec);
                break;
            }
            case 'e': case 'E': {
                const n = Number(arg) || 0; sign = signOf(n); body = Math.abs(n).toExponential(prec === undefined ? 6 : prec);
                if (conv === 'E') body = body.toUpperCase();
                break;
            }
            case 'g': case 'G': {
                const n = Number(arg) || 0; sign = signOf(n); body = String(parseFloat(Math.abs(n).toPrecision(prec || 6)));
                break;
            }
            case 'x': case 'X': {
                body = (Number(arg) >>> 0).toString(16); if (conv === 'X') body = body.toUpperCase();
                if (prec !== undefined) body = body.padStart(prec, '0');
                if (flags.includes('#') && body !== '0') body = (conv === 'X' ? '0X' : '0x') + body;
                break;
            }
            case 'o': body = (Number(arg) >>> 0).toString(8); break;
            case 'b': body = (Number(arg) >>> 0).toString(2); break;
            case 'c': body = String.fromCharCode(Number(arg)); break;
            case 's': default: {
                body = arg === undefined || arg === null ? '' : String(arg);
                if (prec !== undefined) body = body.slice(0, prec);
                break;
            }
        }
        let s = sign + body;
        if (s.length < width) {
            if (left) s = s + ' '.repeat(width - s.length);
            else if (zero) s = sign + body.padStart(width - sign.length, '0');
            else s = ' '.repeat(width - s.length) + s;
        }
        return s;
    });
}

// Flatten nested data into a single-level hash keyed by dotted paths.
// {a:{b:1}, c:[10,20]} -> {"a.b":1, "c.0":10, "c.1":20}
export function collapseHash(data: Data): Data {
    const out: Data = {};
    const walk = (node: Data, prefix: string) => {
        if (isHash(node)) {
            const keys = Object.keys(node);
            if (keys.length === 0 && prefix) { out[prefix] = node; return; }
            for (const k of keys) walk(node[k], prefix ? `${prefix}.${k}` : k);
        } else if (isArray(node)) {
            if (node.length === 0 && prefix) { out[prefix] = node; return; }
            for (let i = 0; i < node.length; i++) walk(node[i], prefix ? `${prefix}.${i}` : String(i));
        } else {
            out[prefix] = node;
        }
    };
    walk(data, '');
    return out;
}

// Inverse of collapseHash: nest dotted keys back into structure (numeric
// path segments become array indices, via the path creator).
export function expandHash(data: Data): Data {
    let out: Data = {};
    if (!isHash(data)) return data;
    for (const k of Object.keys(data)) {
        out = new Path(k).creator(data[k])(out);
    }
    return out;
}
