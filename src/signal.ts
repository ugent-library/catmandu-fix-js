// Sentinel returned by reject() to signal "drop this record". A fix sequence
// stops as soon as it sees it; binds (e.g. marc_each) and the top-level
// transform interpret it as "this item produced no record".
export const REJECT = Symbol('fix.reject');
