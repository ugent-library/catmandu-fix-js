interface MARCMapOpts {
    join_char?: string;
}

/**
 * Given a marc row return the marc tag
 */
export function marctag(row: string[] | undefined) : string {
    if (!row) {
        return "";
    }
    return row[0] ? row[0] : "";
}

/**
 * Given a marc row return an array with the indicators
 */
export function marcind(row: string[] | undefined) : string[] {
    if (!row) {
        return [" "," "];
    }
    let ind1 = row[1] ?? " ";
    let ind2 = row[2] ?? " ";
    return [ind1,ind2];
}

/**
 * Given a marc and a callback function, call function(tag,row)
 * for each tag
 */
export function marcForEachTag(rec: string[][] | undefined , fun: (tag:string, row:string[]) => void) : void {
    if (!rec) return;
    for (let i = 0 ; i < rec.length ; i++) {
        let row = rec[i] ?? [];
        let tag = row[0] ?? "---";
        
        if (tag !== undefined && row !== undefined) {
            fun(tag,row);
        }
    }
}

/**
 * Given a marc row and a callback function, call function(code,value)
 * for each subfield
 */
export function marcForEachSub(row: string[] | undefined , fun: (code:string, value:string) => void) : void {
    if (!row) return;
    for (let i = 3 ; i < row.length ; i +=2) {
        let code = row[i];
        let value = row[i+1];
        
        if (code !== undefined && value !== undefined) {
            fun(code, value);
        }
    }
}

// The tag and subfield regex derived from a field-path depend only on the
// path string, so compile them once per distinct path. Field-paths form a
// tiny fixed set (a handful of MARC tags), so this cache stays small.
const findCache = new Map<string, { tagName: string, subRegex: RegExp }>();

function parseFind(find: string): { tagName: string, subRegex: RegExp } {
    let parsed = findCache.get(find);
    if (!parsed) {
        const tagName = find.substring(0, 3);
        const subMatch = find.substring(3) ? find.substring(3).split("").join("|") : ".*";
        parsed = { tagName, subRegex: new RegExp(`^${subMatch}$`) };
        findCache.set(find, parsed);
    }
    return parsed;
}

/**
 * Given an marc record and a field-path return a string[] with all matching values
 */
export function marcmap(record: string[][], find: string, opts: MARCMapOpts = {}) : string[] {
    const fullOpts = {
        join_char: opts?.join_char ?? " "
    };

    const results : string[] = [];

    const { tagName, subRegex } = parseFind(find);

    for (const row of record) {
        if (row[0] === tagName) {
            results.push(marcsubfields(row,subRegex).join(fullOpts.join_char));
        }
    }

    return results;
}

/**
 * Like marcmap, but returns the individual subfield values (NOT joined per
 * field), flattened across all matching fields. This is what marc_map's
 * `split:1` needs: one array element per subfield value.
 */
export function marcmapList(record: string[][], find: string) : string[] {
    const { tagName, subRegex } = parseFind(find);
    const results : string[] = [];
    for (const row of record) {
        if (row[0] === tagName) results.push(...marcsubfields(row, subRegex));
    }
    return results;
}

/**
 * Given a marc row and a subfield regex, return all matching values
 */
export function marcsubfields(row: string[], re: RegExp) : string[] {
    const result : string[] = [];
    for (let i = 3 ; i < row.length ; i += 2) {
        if (row[i] !== undefined && row[i]?.match(re) && row[i+1] !== undefined) {
            result.push(row[i+1] as string);
        }

    }
    return result;
}