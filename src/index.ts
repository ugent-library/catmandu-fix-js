import { produce, isDraft, setAutoFreeze } from 'immer';
import { parseFix, type Statement } from './parser.js';
import { buildFix } from './fixes.js';
import { buildCondition } from './conditions.js';
import { buildBind } from './binds.js';
import { isHash } from './path.js';
import { REJECT } from './signal.js';

export { Path } from './path.js';
export { FIXES, buildFix } from './fixes.js';
export { parseFix } from './parser.js';
export { buildCondition } from './conditions.js';
export { buildBind } from './binds.js';
export { REJECT } from './signal.js';

type Runner = (data: any) => any;

function compileStatements(stmts: Statement[]): Runner {
    const runners: Runner[] = stmts.map((s) => {
        if (s.type === 'fix') return buildFix(s.name, s.args);
        if (s.type === 'bind') return buildBind(s.name, s.args, compileStatements(s.body), s.doset);
        const cond = buildCondition(s.cond.name, s.cond.args);
        const thenRun = compileStatements(s.then);
        const elseRun = compileStatements(s.otherwise);
        const wantTrue = s.kind === 'if';
        return (data: any) => (cond(data) === wantTrue ? thenRun(data) : elseRun(data));
    });
    return (data: any) => {
        for (const r of runners) {
            data = r(data);
            if (data === REJECT) return REJECT; // stop the sequence on reject()
        }
        return data;
    };
}

// Sentinel thrown out of the immer recipe when the script replaces the whole
// record with an array or a scalar (e.g. `move_field(nested, .)` where the
// value is an array). immer drafts are always objects/arrays, so an
// array/scalar root can't be produced by mutating an object draft — we escape
// the producer and return the (already plain) value directly.
class RootReplaced {
    constructor(public readonly value: any) {}
}

export interface CompileOptions {
    /**
     * Run the compiled chain directly against the record you pass in, mutating
     * it in place (the legacy Catmandu::Path::simple behaviour). Faster — no
     * copy — but the input is modified and must not be shared. Default `false`:
     * the input is left untouched and a new, structurally-shared record is
     * returned.
     */
    inPlace?: boolean;
}

// Wrap a (possibly mutating) runner so that calling it never touches the input
// record. immer hands the runner a copy-on-write draft: in-place setters mutate
// the draft, untouched subtrees are shared with the input by reference, and the
// finalized result is a frozen plain object. The input is guaranteed pristine.
function pure(runner: Runner): Runner {
    return (data: any) => {
        // Only plain objects/arrays are draftable. A scalar (or null) root is
        // immutable anyway, so a cheap clone is enough to keep the runner from
        // mutating any nested structure the caller still holds.
        if (data === null || typeof data !== 'object') {
            return runner(structuredClone(data));
        }
        let rejected = false;
        let next: any;
        try {
            next = produce(data, (draft: any) => {
                const out = runner(draft);
                if (out === REJECT) { rejected = true; return; }
                // Common case: the chain mutated the draft in place (or a fix
                // returned a sub-draft of it). Let immer finalize the draft.
                if (out === draft || isDraft(out)) return;
                // The chain replaced the whole record with a fresh value.
                // Fold an object root back into the draft so immer sees a
                // single mutated draft (never "mutated AND returned").
                if (isHash(out)) {
                    for (const k of Object.keys(draft)) delete draft[k];
                    Object.assign(draft, out);
                    return;
                }
                // Array / scalar root: escape and return it verbatim. These are
                // always built fresh (move/copy clone their values, set_array /
                // set_field produce plain values), so no live draft leaks out.
                throw new RootReplaced(out);
            });
        } catch (e) {
            if (e instanceof RootReplaced) return e.value;
            throw e;
        }
        return rejected ? REJECT : next;
    };
}

/**
 * Compile a Catmandu Fix script into a record -> record function.
 * Parsed and built once; the returned function just runs the chain per record.
 *
 * By default the returned function is **pure**: it does not mutate the record
 * you pass in. It hands the chain a copy-on-write view (via immer), so
 * untouched parts of the record are shared with the input by reference and only
 * the fields a fix actually changes are copied. The result is a new, frozen
 * record. This makes a compiled fix safe to apply to a shared/reused record,
 * to keep alongside its original, and to run concurrently.
 *
 * Pass `{ inPlace: true }` to opt back into the legacy mutating behaviour for
 * maximum throughput when you own the record and don't need the original.
 */
export function compileFix(src: string, opts: CompileOptions = {}): (data: any) => any {
    const runner = compileStatements(parseFix(src));
    return opts.inPlace ? runner : pure(runner);
}

/** Toggle immer's auto-freezing of pure results (on by default). */
export { setAutoFreeze };
