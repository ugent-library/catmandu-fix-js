import { parseFix, type Statement } from './parser.js';
import { buildFix } from './fixes.js';
import { buildCondition } from './conditions.js';
import { buildBind } from './binds.js';
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

/**
 * Compile a Catmandu Fix script into a record -> record function.
 * Parsed and built once; the returned function just runs the chain per record.
 */
export function compileFix(src: string): (data: any) => any {
    return compileStatements(parseFix(src));
}
