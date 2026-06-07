// XML text/attribute escaping shared by the MARCXML exporter (src/output/xml.ts)
// and the marc_xml fix (src/fix/fixes.ts). Strips characters disallowed in XML
// 1.0 and escapes the markup-significant ones.

// True if the string contains any character escapeXML would change: & < >
// (and " ' for attributes), disallowed XML 1.0 control chars, surrogates, or
// non-characters. A single char-code scan; lets the common (clean) case skip
// the 5-7 regex replaces below. No literal control chars in source.
export function needsEscape(s: string, forAttribute: boolean): boolean {
    for (let i = 0; i < s.length; i++) {
        const c = s.charCodeAt(i);
        if (c === 38 || c === 60 || c === 62) return true;                 // & < >
        if (forAttribute && (c === 34 || c === 39)) return true;           // " '
        if (c <= 0x08 || c === 0x0B || c === 0x0C || (c >= 0x0E && c <= 0x1F)) return true; // ctrl
        if (c >= 0x7F && c <= 0x9F) return true;
        if (c >= 0xD800 && c <= 0xDFFF) return true;                       // surrogates
        if (c >= 0xFDD0 && c <= 0xFDEF) return true;                       // non-chars
        if (c === 0xFFFE || c === 0xFFFF) return true;
    }
    return false;
}

export function escapeXML(
    value: string | number | null | undefined,
    options?: { forAttribute?: boolean }
): string {
    if (value === null || value === undefined) return '';

    let s = String(value);

    // Fast path: most values are clean, so skip the regex replaces below.
    if (!needsEscape(s, options?.forAttribute === true)) return s;

    // STEP 1: Remove/replace invalid UTF-8 and disallowed XML characters

    // Remove unpaired UTF-16 surrogates (invalid in JSON and problematic in XML)
    s = s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/g, '\uFFFD');  // unpaired high surrogates
    s = s.replace(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '\uFFFD'); // unpaired low surrogates

    // Remove other disallowed XML 1.0 characters:
    // Control chars: 0x00-0x08, 0x0B, 0x0C, 0x0E-0x1F, 0x7F-0x9F
    // Non-characters: 0xFFFE, 0xFFFF, 0x1FFFE, 0x1FFFF, etc.
    s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\uFFFE\uFFFF]/g, '');

    // Remove other non-characters (U+FFFE, U+FFFF in other planes)
    // These can occur as U+FFFE, U+FFFF, U+1FFFE, U+1FFFF, etc.
    s = s.replace(/[\uFDD0-\uFDEF]/g, '');

    // STEP 2: Escape XML special characters
    // IMPORTANT: Always escape & FIRST to avoid double-escaping
    s = s.replace(/&/g, '&amp;');

    // Escape other special characters
    s = s.replace(/</g, '&lt;');
    s = s.replace(/>/g, '&gt;');

    if (options?.forAttribute) {
        s = s.replace(/"/g, '&quot;');
        s = s.replace(/'/g, '&apos;');
    }

    return s;
}
