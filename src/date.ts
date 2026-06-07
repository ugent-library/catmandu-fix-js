// Minimal strptime / strftime supporting the conversion specifiers Catmandu's
// `datetime_format` fix (Catmandu::Fix::Date) relies on. Dates are handled in
// UTC — Catmandu's default time_zone — which is what the date-reformatting use
// case needs (e.g. "%Y%m%d" -> "%Y" to pull a year out of a packed date).
//
// Supported specifiers: %Y %y %m %d %e %H %I %M %S %j %p %P %B %b %h %A %a
// %Z %z %n %t %% and the composites %F %T %R %D. Unknown specifiers in a parse
// pattern make strptime() return null (the value can't be interpreted).

const MONTH_FULL = ['January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'];
const MONTH_ABBR = MONTH_FULL.map((m) => m.slice(0, 3));
const DAY_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const DAY_ABBR = DAY_FULL.map((d) => d.slice(0, 3));

const COMPOSITES: Record<string, string> = { F: '%Y-%m-%d', T: '%H:%M:%S', R: '%H:%M', D: '%m/%d/%y' };

function pad(n: number, w: number): string {
    return String(Math.abs(n)).padStart(w, '0');
}
function reEsc(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function yearDay(d: Date): number {
    const start = Date.UTC(d.getUTCFullYear(), 0, 1);
    return Math.floor((d.getTime() - start) / 86400000) + 1;
}

// Expand %F/%T/%R/%D into their primitive specifiers, leaving %% (a literal
// percent) and every other specifier untouched.
function expandComposites(p: string): string {
    let out = '';
    for (let i = 0; i < p.length; i++) {
        if (p[i] !== '%') { out += p[i]; continue; }
        const s = p[i + 1];
        if (s === '%') { out += '%%'; i++; continue; }
        if (s !== undefined && COMPOSITES[s]) { out += COMPOSITES[s]; i++; continue; }
        out += '%' + (s ?? ''); i++;
    }
    return out;
}

interface Acc {
    year?: number; month?: number; day?: number;
    hour?: number; min?: number; sec?: number;
    hour12?: number; pm?: boolean; yday?: number;
}

// Parse `input` against a strptime `pattern`. Returns a UTC Date, or null if
// the input does not match the whole pattern (or the pattern has an unknown
// specifier). Mirrors DateTime::Format::Strptime's on_error => 'undef'.
export function strptime(pattern: string, input: string): Date | null {
    const p = expandComposites(pattern);
    const handlers: Array<(m: string, a: Acc) => void> = [];
    const nameAlt = (names: string[]) =>
        names.slice().sort((a, b) => b.length - a.length).map(reEsc).join('|');
    const monthIdx = (m: string) => {
        const lc = m.toLowerCase();
        const i = MONTH_FULL.findIndex((x) => x.toLowerCase() === lc);
        return i >= 0 ? i : MONTH_ABBR.findIndex((x) => x.toLowerCase() === lc);
    };

    let re = '^';
    for (let i = 0; i < p.length; i++) {
        const c = p[i]!;
        if (c !== '%') { re += reEsc(c); continue; }
        const s = p[++i];
        switch (s) {
            case 'Y': re += '([+-]?\\d{1,4})'; handlers.push((m, a) => { a.year = +m; }); break;
            case 'y': re += '(\\d{2})'; handlers.push((m, a) => { const n = +m; a.year = n < 69 ? 2000 + n : 1900 + n; }); break;
            case 'm': re += '(\\d{1,2})'; handlers.push((m, a) => { a.month = +m; }); break;
            case 'd': case 'e': re += '\\s?(\\d{1,2})'; handlers.push((m, a) => { a.day = +m; }); break;
            case 'H': re += '(\\d{1,2})'; handlers.push((m, a) => { a.hour = +m; }); break;
            case 'I': re += '(\\d{1,2})'; handlers.push((m, a) => { a.hour12 = +m; }); break;
            case 'M': re += '(\\d{1,2})'; handlers.push((m, a) => { a.min = +m; }); break;
            case 'S': re += '(\\d{1,2})'; handlers.push((m, a) => { a.sec = +m; }); break;
            case 'j': re += '(\\d{1,3})'; handlers.push((m, a) => { a.yday = +m; }); break;
            case 'p': case 'P': re += '([AaPp][Mm])'; handlers.push((m, a) => { a.pm = /^p/i.test(m); }); break;
            case 'B': case 'b': case 'h':
                re += '(' + nameAlt(s === 'B' ? MONTH_FULL : MONTH_ABBR) + ')';
                handlers.push((m, a) => { const x = monthIdx(m); if (x >= 0) a.month = x + 1; });
                break;
            case 'A': case 'a':
                re += '(' + nameAlt(s === 'A' ? DAY_FULL : DAY_ABBR) + ')';
                handlers.push(() => { /* weekday: matched but not needed to fix the date */ });
                break;
            case 'Z': re += '([A-Za-z]+)'; handlers.push(() => {}); break;
            case 'z': re += '([+-]\\d{2}:?\\d{2}|Z)'; handlers.push(() => {}); break;
            case 'n': case 't': re += '\\s+'; break;
            case '%': re += '%'; break;
            default: return null; // unknown specifier -> not parseable
        }
    }
    re += '$';

    const m = new RegExp(re).exec(input);
    if (!m) return null;

    const a: Acc = {};
    for (let i = 0; i < handlers.length; i++) handlers[i]!(m[i + 1]!, a);

    let hour = a.hour ?? 0;
    if (a.hour12 !== undefined) { hour = a.hour12 % 12; if (a.pm) hour += 12; }
    const year = a.year ?? 1970;
    const min = a.min ?? 0;
    const sec = a.sec ?? 0;

    if (a.yday !== undefined) {
        if (a.yday < 1 || a.yday > 366) return null;
        const dt = new Date(Date.UTC(year, 0, 1, hour, min, sec) + (a.yday - 1) * 86400000);
        return Number.isNaN(dt.getTime()) ? null : dt;
    }

    const mon = a.month ?? 1, day = a.day ?? 1;
    const dt = new Date(Date.UTC(year, mon - 1, day, hour, min, sec));
    if (Number.isNaN(dt.getTime())) return null;
    // Reject components that didn't round-trip: an out-of-range month/day, or a
    // partial input like "1803" matched against "%Y%m%d" — which back-tracks to
    // an invalid month=0/day=3 rather than a bare year. This mirrors
    // DateTime::Format::Strptime returning undef, leaving the value unchanged.
    // (Years 0-99 are likewise rejected, since JS Date remaps them to 19xx.)
    if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== mon - 1 || dt.getUTCDate() !== day) {
        return null;
    }
    return dt;
}

// Format a UTC Date with a strftime `pattern`.
export function strftime(pattern: string, d: Date): string {
    const p = expandComposites(pattern);
    const Y = d.getUTCFullYear(), mo = d.getUTCMonth(), da = d.getUTCDate();
    const H = d.getUTCHours(), Mi = d.getUTCMinutes(), S = d.getUTCSeconds(), wd = d.getUTCDay();
    let out = '';
    for (let i = 0; i < p.length; i++) {
        if (p[i] !== '%') { out += p[i]; continue; }
        const s = p[++i];
        switch (s) {
            case 'Y': out += pad(Y, 4); break;
            case 'y': out += pad(Y % 100, 2); break;
            case 'm': out += pad(mo + 1, 2); break;
            case 'd': out += pad(da, 2); break;
            case 'e': out += String(da).padStart(2, ' '); break;
            case 'H': out += pad(H, 2); break;
            case 'I': out += pad((H % 12) || 12, 2); break;
            case 'M': out += pad(Mi, 2); break;
            case 'S': out += pad(S, 2); break;
            case 'p': out += H < 12 ? 'AM' : 'PM'; break;
            case 'P': out += H < 12 ? 'am' : 'pm'; break;
            case 'B': out += MONTH_FULL[mo]; break;
            case 'b': case 'h': out += MONTH_ABBR[mo]; break;
            case 'A': out += DAY_FULL[wd]; break;
            case 'a': out += DAY_ABBR[wd]; break;
            case 'j': out += pad(yearDay(d), 3); break;
            case 'Z': out += 'UTC'; break;
            case 'z': out += '+0000'; break;
            case 'n': out += '\n'; break;
            case 't': out += '\t'; break;
            case '%': out += '%'; break;
            default: out += '%' + (s ?? ''); break;
        }
    }
    return out;
}
