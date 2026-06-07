// Parser for Catmandu Fix scripts. Supports statement-form fix calls plus
// if/unless ... [else] ... end conditional blocks and do/doset ... end binds
// (compiled with full bind semantics by index.ts via buildBind).
//
// Tokens follow Catmandu::Fix::Parser: bare strings, single/double quoted
// strings (with Catmandu's escape rules), and `, : =>` as separators.

export interface FixCall { type: 'fix'; name: string; args: string[]; }
export interface CondBlock {
    type: 'cond';
    kind: 'if' | 'unless';
    cond: { name: string; args: string[] };
    then: Statement[];
    otherwise: Statement[];
}
export interface BindBlock {
    type: 'bind';
    name: string;
    args: string[];
    body: Statement[];
    doset: boolean;
}
export type Statement = FixCall | CondBlock | BindBlock;

export function parseFix(src: string): Statement[] {
    let i = 0;
    const n = src.length;
    const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\r' || c === '\n';

    function skipTrivia() {
        while (i < n) {
            const c = src[i]!;
            if (isSpace(c) || c === ';' || c === ',') { i++; continue; }
            if (c === '#') { while (i < n && src[i] !== '\n') i++; continue; }
            break;
        }
    }

    function readWord(): string {
        let w = '';
        while (i < n && /[A-Za-z0-9_.]/.test(src[i]!)) { w += src[i]; i++; }
        return w;
    }

    // single quotes: keep backslashes except \' -> ' ; double quotes: \n \r \t \b \f \\ \" \uXXXX
    function readQuoted(q: string): string {
        i++;
        let out = '';
        while (i < n) {
            const c = src[i]!;
            if (c === q) { i++; break; }
            if (c === '\\') {
                const nx = src[i + 1] ?? '';
                if (q === "'") {
                    if (nx === "'") { out += "'"; i += 2; } else { out += '\\'; i += 1; }
                } else {
                    const map: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '"': '"', '\\': '\\' };
                    if (nx === 'u' && /[0-9A-Fa-f]{4}/.test(src.slice(i + 2, i + 6))) {
                        out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16)); i += 6;
                    } else if (nx in map) { out += map[nx]; i += 2; }
                    else { out += '\\'; i += 1; }
                }
                continue;
            }
            out += c; i++;
        }
        return out;
    }

    function readArgs(): string[] {
        const args: string[] = [];
        i++; // (
        for (;;) {
            while (i < n && (isSpace(src[i]!) || src[i] === ',' || src[i] === ':')) i++;
            if (i >= n || src[i] === ')') { i++; break; }
            const c = src[i]!;
            if (c === "'" || c === '"') { args.push(readQuoted(c)); continue; }
            let s = '';
            while (i < n && !/[\s,:()"']/.test(src[i]!) && !(src[i] === '=' && src[i + 1] === '>')) { s += src[i]; i++; }
            if (src[i] === '=' && src[i + 1] === '>') i += 2;
            args.push(s);
        }
        return args;
    }

    // parse statements until one of `stops` is seen; returns the stop word too
    function parseBlock(stops: string[]): { stmts: Statement[]; stop: string } {
        const stmts: Statement[] = [];
        while (i < n) {
            skipTrivia();
            if (i >= n) break;
            if (src[i] === ')') { i++; continue; }
            const word = readWord();
            if (!word) { i++; continue; }
            if (stops.includes(word)) return { stmts, stop: word };

            if (word === 'if' || word === 'unless') {
                while (i < n && isSpace(src[i]!)) i++;
                const condName = readWord();
                while (i < n && isSpace(src[i]!)) i++;
                const condArgs = src[i] === '(' ? readArgs() : [];
                const thenBlock = parseBlock(['else', 'end']);
                let otherwise: Statement[] = [];
                if (thenBlock.stop === 'else') otherwise = parseBlock(['end']).stmts;
                stmts.push({ type: 'cond', kind: word, cond: { name: condName, args: condArgs }, then: thenBlock.stmts, otherwise });
            } else if (word === 'do' || word === 'doset') {
                while (i < n && isSpace(src[i]!)) i++;
                const bindName = readWord();
                while (i < n && isSpace(src[i]!)) i++;
                const bindArgs = src[i] === '(' ? readArgs() : [];
                const body = parseBlock(['end']).stmts;
                stmts.push({ type: 'bind', name: bindName, args: bindArgs, body, doset: word === 'doset' });
            } else {
                while (i < n && isSpace(src[i]!)) i++;
                const args = src[i] === '(' ? readArgs() : [];
                stmts.push({ type: 'fix', name: word, args });
            }
        }
        return { stmts, stop: '' };
    }

    return parseBlock([]).stmts;
}
