import { describe, test, expect } from "@jest/globals";
import { compileFix, REJECT } from "../dist/index.js";

// compileFix() is pure by default: it must never mutate the record it is given,
// it must return exactly what the legacy in-place engine produces, and it must
// share untouched subtrees with the input by reference (structural sharing).

const SCRIPTS: Array<[string, any]> = [
    ["upcase(title)", { id: 1, title: "hi", tags: ["a", "b"], meta: { y: 2024 } }],
    ['append(v,"!")', { v: "x" }],
    ["add_field(seen, yes)", { id: 1 }],
    ["copy_field(old, new)", { old: "o" }],
    ["move_field(old, new)", { old: "o", keep: 1 }],
    ["copy_field(nested, .)", { nested: { bar: "baz" }, foo: "bar" }], // object root replace
    ["copy_field(nested, .)", { nested: [1, 2, 3], foo: "bar" }],      // ARRAY root replace
    ["move_field(nested, .)", { nested: [1, 2, 3], foo: "bar" }],      // ARRAY root replace
    ["set_field(., hello)", { a: 1 }],                                 // SCALAR root replace
    ["upcase(title) collapse()", { title: "hi", meta: { y: 2024, z: { q: 1 } } }], // mutate THEN replace root
    ["collapse()", { a: { b: 1 }, c: [10, 20] }],
    ["expand()", { "a.b": 1, "c.0": 10, "c.1": 20 }],
    ["retain(keep)", { keep: 1, drop: 2, x: 3 }],
    ["do with(meta) add_field(touched,1) end", { meta: { y: 1 }, other: 9 }],
    ["if exists(title) upcase(title) end", { title: "hi" }],
    ["if exists(nope) upcase(title) else add_field(z,1) end", { title: "hi" }],
    ["sort_field(xs, numeric:1)", { xs: [3, 1, 2] }],
    ["marc_map(245a, title)", { record: [["245", " ", " ", "a", "Hello"]] }],
];

describe("compileFix purity", () => {
    test.each(SCRIPTS)("%s leaves input untouched and matches in-place output", (src, rec) => {
        const pureFn = compileFix(src);
        const inPlaceFn = compileFix(src, { inPlace: true });

        const input = structuredClone(rec);
        const snapshot = structuredClone(rec);
        const out = pureFn(input);

        expect(input).toEqual(snapshot);                         // input pristine
        expect(out).toEqual(inPlaceFn(structuredClone(rec)));    // same result as legacy engine
    });

    test("shares untouched subtrees by reference (structural sharing)", () => {
        const input = { title: "hi", big: { deep: { list: [1, 2, 3] } } };
        const out = compileFix("upcase(title)")(input);
        expect(out).not.toBe(input);          // a new record
        expect(out.big).toBe(input.big);      // but untouched subtree is shared, not deep-copied
    });

    test("result is frozen by default (true immutability)", () => {
        const out = compileFix("upcase(title)")({ title: "hi", meta: { y: 1 } });
        expect(Object.isFrozen(out)).toBe(true);
        expect(Object.isFrozen(out.meta)).toBe(true);
    });

    test("reject() still propagates the REJECT sentinel", () => {
        expect(compileFix("reject()")({ a: 1 })).toBe(REJECT);
    });

    test("inPlace:true keeps the legacy mutating behaviour", () => {
        const input = { title: "hi" };
        const out = compileFix("upcase(title)", { inPlace: true })(input);
        expect(out).toBe(input);              // same object, mutated in place
        expect(input.title).toBe("HI");
    });
});
