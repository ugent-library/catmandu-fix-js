import { describe, test, expect } from "@jest/globals";
import { buildFix, compileFix } from "../dist/index.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Apply a fix the way Catmandu's unit tests do: build it from args, run on a
// (cloned) input record, compare to the expected output. Cases are ported
// verbatim from Catmandu's t/Catmandu-Fix-*.t (is_deeply assertions).
function fix(name: string, args: string[], data: any): any {
    return buildFix(name, args)(structuredClone(data));
}

describe("Fix conformance — ported from Catmandu t/", () => {
    test("copy_field", () => {
        expect(fix("copy_field", ["old", "new"], { old: "old" })).toEqual({ old: "old", new: "old" });
        expect(fix("copy_field", ["old", "deeply.nested.$append.new"], { old: "old" }))
            .toEqual({ old: "old", deeply: { nested: [{ new: "old" }] } });
        expect(fix("copy_field", ["old.*", "deeply.nested.$append.new"], { old: ["old", "older"] }))
            .toEqual({ old: ["old", "older"], deeply: { nested: [{ new: "old" }, { new: "older" }] } });
        expect(fix("copy_field", ["nested", "."], { nested: { bar: "baz" }, foo: "bar" })).toEqual({ bar: "baz" });
        expect(fix("copy_field", ["nested", "."], { nested: [1, 2, 3], foo: "bar" })).toEqual([1, 2, 3]);
        expect(fix("copy_field", ["''", "test"], { "": "foo" })).toEqual({ "": "foo", test: "foo" });
        expect(fix("copy_field", ["test", "''"], { test: "foo" })).toEqual({ test: "foo", "": "foo" });
        expect(fix("copy_field", ["test", "x.''"], { test: "foo" })).toEqual({ test: "foo", x: { "": "foo" } });
    });

    test("move_field", () => {
        expect(fix("move_field", ["old", "new"], { old: "old" })).toEqual({ new: "old" });
        expect(fix("move_field", ["old", "deeply.nested.$append.new"], { old: "old" }))
            .toEqual({ deeply: { nested: [{ new: "old" }] } });
        expect(fix("move_field", ["nested", "."], { nested: { bar: "baz" }, foo: "bar" })).toEqual({ bar: "baz" });
        expect(fix("move_field", ["nested", "."], { nested: [1, 2, 3], foo: "bar" })).toEqual([1, 2, 3]);
        expect(fix("move_field", ["''", "test"], { "": "foo" })).toEqual({ test: "foo" });
        expect(fix("move_field", ["test", "''"], { test: "foo" })).toEqual({ "": "foo" });
        expect(fix("move_field", ["test", "x.''"], { test: "foo" })).toEqual({ x: { "": "foo" } });
    });

    test("add_field (creates intermediate path)", () => {
        expect(fix("add_field", ["job", "fixer"], {})).toEqual({ job: "fixer" });
        expect(fix("add_field", ["deeply.nested.$append.job", "fixer"], {}))
            .toEqual({ deeply: { nested: [{ job: "fixer" }] } });
        expect(fix("add_field", ["deeply.nested.1.job", "fixer"], {}))
            .toEqual({ deeply: { nested: [undefined, { job: "fixer" }] } });
        expect(fix("add_field", ["deeply.nested.$append.job", "fixer"], { deeply: { nested: {} } }))
            .toEqual({ deeply: { nested: {} } });
        expect(fix("add_field", ["test", "0123"], {})).toEqual({ test: "0123" });
        expect(fix("add_field", ["test"], {})).toEqual({ test: null });
        expect(fix("add_field", ["''", "empty"], {})).toEqual({ "": "empty" });
        expect(fix("add_field", ["'a'", "test"], {})).toEqual({ a: "test" });
        expect(fix("add_field", ['"a"', "test"], {})).toEqual({ a: "test" });
    });

    test("set_field (only sets if intermediate exists)", () => {
        expect(fix("set_field", ["job", "fixer"], {})).toEqual({ job: "fixer" });
        expect(fix("set_field", ["deeply.nested.$append.job", "fixer"], {})).toEqual({});
        expect(fix("set_field", ["deeply.nested.*.job", "fixer"], { deeply: { nested: [undefined, {}] } }))
            .toEqual({ deeply: { nested: [undefined, { job: "fixer" }] } });
        expect(fix("set_field", ["test", "0123"], { test: "ok" })).toEqual({ test: "0123" });
        expect(fix("set_field", ['"a b c"', "test"], {})).toEqual({ "a b c": "test" });
    });

    test("remove_field", () => {
        expect(fix("remove_field", ["remove"], { remove: "me", keep: "me" })).toEqual({ keep: "me" });
        expect(fix("remove_field", ["''"], { a: "A", "": "Empty", c: "C" })).toEqual({ a: "A", c: "C" });
        expect(fix("remove_field", ['""'], { a: "A", "": "Empty", c: "C" })).toEqual({ a: "A", c: "C" });
        expect(fix("remove_field", ["x.''"], { x: { a: "A", "": "Empty", c: "C" } })).toEqual({ x: { a: "A", c: "C" } });
    });

    test("upcase / downcase / capitalize", () => {
        expect(fix("upcase", ["name"], { name: "joe" })).toEqual({ name: "JOE" });
        expect(fix("upcase", ["names.*.name"], { names: [{ name: "joe" }, { name: "rick" }] }))
            .toEqual({ names: [{ name: "JOE" }, { name: "RICK" }] });
        expect(fix("downcase", ["name"], { name: "JOE" })).toEqual({ name: "joe" });
        expect(fix("capitalize", ["name"], { name: "joe" })).toEqual({ name: "Joe" });
        expect(fix("capitalize", ["names.*"], { names: ["joe", "rick"] })).toEqual({ names: ["Joe", "Rick"] });
    });

    test("trim", () => {
        expect(fix("trim", ["name"], { name: "\tjoe  " })).toEqual({ name: "joe" });
        expect(fix("trim", ["name", "nonword"], { name: "/\tjoe  .  " })).toEqual({ name: "joe" });
        expect(fix("trim", ["id", "whitespace"], { id: " 0423985325   " })).toEqual({ id: "0423985325" });
        expect(fix("trim", ["name", "whitespace"], { name: " 宮川   " })).toEqual({ name: "宮川" });
    });

    test("replace_all", () => {
        expect(fix("replace_all", ["date", "\\d{2}", "01"], { date: "July 23" })).toEqual({ date: "July 01" });
        expect(fix("replace_all", ["date", "(\\d{2})", "${1}th"], { date: "July 23" })).toEqual({ date: "July 23th" });
        expect(fix("replace_all", ["words", "/b", ""], { words: "/bar" })).toEqual({ words: "ar" });
    });

    test("prepend / append", () => {
        expect(fix("prepend", ["name", "mr. "], { name: "smith" })).toEqual({ name: "mr. smith" });
        expect(fix("append", ["name", "y"], { name: "joe" })).toEqual({ name: "joey" });
        expect(fix("append", ["names.*.name"], { names: [{ name: "joe" }] })).toBeDefined();
    });

    test("join_field / split_field", () => {
        expect(fix("join_field", ["joinme", ","], { joinme: ["J", "O", "I", "N"] })).toEqual({ joinme: "J,O,I,N" });
        expect(fix("join_field", ["joinme", ","], { joinme: { skip: "me" } })).toEqual({ joinme: { skip: "me" } });
        expect(fix("join_field", ["joinme", ","], { joinme: ["J", { skip: "me" }, "I", "N"] })).toEqual({ joinme: "J,I,N" });
        expect(fix("split_field", ["splitme", ","], { splitme: "a,b,c" })).toEqual({ splitme: ["a", "b", "c"] });
        expect(fix("split_field", ["splitme", ","], { splitme: ["a", "b", "c"] })).toEqual({ splitme: ["a", "b", "c"] });
    });

    test("marc_map (reuses marcattacks marcmap)", () => {
        const rec = () => ({
            record: [
                ["001", " ", " ", "_", "123"],
                ["245", "1", "0", "a", "Hello", "b", "World"],
                ["500", " ", " ", "a", "note1"],
                ["500", " ", " ", "a", "note2"],
            ],
        });
        expect(fix("marc_map", ["001", "id"], rec()).id).toBe("123");
        expect(fix("marc_map", ["245ab", "title", "join", " "], rec()).title).toBe("Hello World");
        expect(fix("marc_map", ["500a", "notes", "split", "1"], rec()).notes).toEqual(["note1", "note2"]);
        expect(fix("marc_map", ["024a", "isbn", "value", "Y"], rec()).isbn).toBeUndefined(); // no 024 -> untouched
        expect(fix("marc_map", ["001", "found", "value", "Y"], rec()).found).toBe("Y");      // value: constant
        expect(fix("marc_map", ["100a", "deep.$append.name"], rec()).deep).toBeUndefined();   // no 100 -> untouched
    });

    test("conditionals: if / unless / else + conditions", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // if exists
        expect(run("if exists(a) add_field(seen, yes) end", { a: 1 })).toEqual({ a: 1, seen: "yes" });
        expect(run("if exists(a) add_field(seen, yes) end", { b: 1 })).toEqual({ b: 1 });
        // unless
        expect(run("unless exists(a) add_field(missing, yes) end", { b: 1 })).toEqual({ b: 1, missing: "yes" });
        // if/else
        expect(run("if exists(a) add_field(r, A) else add_field(r, B) end", { a: 1 })).toEqual({ a: 1, r: "A" });
        expect(run("if exists(a) add_field(r, A) else add_field(r, B) end", {})).toEqual({ r: "B" });
        // all_equal / all_match
        expect(run("if all_equal(t, book) set_field(t, Book) end", { t: "book" })).toEqual({ t: "Book" });
        expect(run("if all_match(id, '\\(viaf\\)') add_field(viaf, yes) end", { id: "(viaf)123" })).toEqual({ id: "(viaf)123", viaf: "yes" });
        expect(run("if all_match(id, '\\(viaf\\)') add_field(viaf, yes) end", { id: "(ugent)1" })).toEqual({ id: "(ugent)1" });
    });

    test("binds: do list", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // list over array of objects (no var): apply the block to each element
        expect(run("do list(path:items) add_field(seen, y) end", { items: [{ a: 1 }, { a: 2 }] }))
            .toEqual({ items: [{ a: 1, seen: "y" }, { a: 2, seen: "y" }] });
        // list with var: build an array of objects from a list of values
        // (the marc2rdf subjects idiom, validated identical to the real catmandu CLI)
        expect(run(
            "marc_map('500a', _s, split, 1) do list(path:_s, var:x) copy_field(x, out.$append.name) add_field(out.$last.t, S) end remove_field(_s) remove_field(record)",
            { record: [["500", " ", " ", "a", "one"], ["500", " ", " ", "a", "two"]] }
        )).toEqual({ out: [{ name: "one", t: "S" }, { name: "two", t: "S" }] });
    });

    test("marc_each bind (MARC field iteration, marc_match, reject)", () => {
        const rec = () => ({
            record: [
                ["001", " ", " ", "_", "R1"],
                ["500", " ", " ", "a", "Test"],
                ["500", " ", " ", "a", "Test2", "e", "skip"],
                ["500", " ", " ", "a", "Test3"],
            ],
        });
        // copy 500 -> note unless $e == skip (Catmandu's documented example)
        expect(compileFix(
            "do marc_each() unless marc_match('500e', skip) marc_map('500', note.$append) end end remove_field(record)"
        )(rec())).toEqual({ note: ["Test", "Test3"] });
        // reject() drops the matching field, keeps the rest
        const out = compileFix(
            "do marc_each() if marc_match('500e', skip) reject() end end"
        )(rec());
        expect(out.record.length).toBe(3);
        expect(out.record.some((f: string[]) => f.includes("skip"))).toBe(false);
    });

    test("marc_xml (serialize the MARC record to MARCXML)", () => {
        const rec = () => ({
            record: [
                ["LDR", " ", " ", "_", "00000nam a2200000 a 4500"],
                ["001", " ", " ", "_", "R1"],
                ["100", "1", " ", "a", "Smith, J.", "d", "1900-1980"],
                ["245", "1", "0", "a", "A <title> & 'more'"],
            ],
        });
        // marc_xml(record) replaces the array with the XML string; the script
        // idiom then moves it to a display field.
        const out = compileFix("marc_xml(record) move_field(record, marc_display)")(rec());
        expect(out.record).toBeUndefined();
        expect(out.marc_display).toBe(
            '<marc:record xmlns:marc="http://www.loc.gov/MARC21/slim">' +
            '<marc:leader>00000nam a2200000 a 4500</marc:leader>' +
            '<marc:controlfield tag="001">R1</marc:controlfield>' +
            '<marc:datafield tag="100" ind1="1" ind2=" ">' +
            '<marc:subfield code="a">Smith, J.</marc:subfield>' +
            '<marc:subfield code="d">1900-1980</marc:subfield>' +
            '</marc:datafield>' +
            '<marc:datafield tag="245" ind1="1" ind2="0">' +
            '<marc:subfield code="a">A &lt;title&gt; &amp; &apos;more&apos;</marc:subfield>' +
            '</marc:datafield>' +
            '</marc:record>'
        );
        // a record with no `record` array is left untouched
        expect(compileFix("marc_xml(record)")({ id: 1 })).toEqual({ id: 1 });
    });

    test("binds: do with (descend into a path)", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // with over an array: block runs on each element as root
        expect(run("do with(path:colors) upcase(name) end", { colors: [{ name: "red" }, { name: "green" }] }))
            .toEqual({ colors: [{ name: "RED" }, { name: "GREEN" }] });
        // positional path form
        expect(run("do with(colors) add_field(seen, y) end", { colors: [{ name: "red" }] }))
            .toEqual({ colors: [{ name: "red", seen: "y" }] });
        // with over a hash: block runs once on that hash as root
        expect(run("do with(path:author) upcase(last) end", { author: { last: "smith" } }))
            .toEqual({ author: { last: "SMITH" } });
        // scalar (or missing) path leaves the record untouched
        expect(run("do with(path:x) add_field(seen, y) end", { x: "plain" }))
            .toEqual({ x: "plain" });
        expect(run("do with(path:nope) add_field(seen, y) end", { a: 1 }))
            .toEqual({ a: 1 });
    });

    test("binds: do each (loop array/hash entries via var)", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // each over a hash: var exposes {key, value}; build an array of pairs
        expect(run(
            "do each(path:data, var:c) copy_field(c.key, kv.$append.key) copy_field(c.value, kv.$last.value) end remove_field(data)",
            { data: { foo: 1, bar: 2 } }
        )).toEqual({ kv: [{ key: "foo", value: 1 }, { key: "bar", value: 2 }] });
        // each over an array: var exposes {index, value}
        expect(run(
            "do each(path:xs, var:c) copy_field(c.index, out.$append.i) copy_field(c.value, out.$last.v) end remove_field(xs)",
            { xs: ["a", "b"] }
        )).toEqual({ out: [{ i: 0, v: "a" }, { i: 1, v: "b" }] });
        // var is removed after the loop (not left on the record)
        expect(run("do each(path:xs, var:c) add_field(n, x) end", { xs: [1, 2] }).c).toBeUndefined();
        // without var: block runs once per entry (here: append a marker each time)
        expect(run("do each(path:xs) add_field(hits.$append, x) end", { xs: [1, 2, 3] }).hits)
            .toEqual(["x", "x", "x"]);
    });

    test("conditions: comparisons / type checks / in (all-values semantics)", () => {
        // a condition is true iff there is >=1 value and ALL values pass
        const t = (cond: string, data: any) => "m" in compileFix(`if ${cond} add_field(m, Y) end`)(structuredClone(data));
        expect(t("greater_than(year, 2018)", { year: "2019" })).toBe(true);
        expect(t("greater_than(year, 2018)", { year: 2018 })).toBe(false);
        expect(t("greater_than(nums.*, 5)", { nums: [6, 7, 8] })).toBe(true);
        expect(t("greater_than(nums.*, 5)", { nums: [1, 2, 9] })).toBe(false); // not ALL > 5
        expect(t("less_than(year, 2018)", { year: 2017 })).toBe(true);
        expect(t("is_number(v)", { v: "42" })).toBe(true);
        expect(t("is_number(xs.*)", { xs: [1, "a"] })).toBe(false);
        expect(t("is_object(v)", { v: { a: 1 } })).toBe(true);
        expect(t("is_object(v)", { v: [1] })).toBe(false);
        expect(t("is_null(v)", { v: null })).toBe(true);
        expect(t("is_null(v)", { v: 0 })).toBe(false);
        expect(t("is_true(v)", { v: 1 })).toBe(true);          // loose
        expect(t("is_true(v, strict, 1)", { v: 1 })).toBe(false); // strict: only real bool
        expect(t("is_true(v, strict, 1)", { v: true })).toBe(true);
        expect(t("is_false(v)", { v: "false" })).toBe(true);
        expect(t("in(a, b)", { a: 42, b: 42 })).toBe(true);
        expect(t("in(a, b)", { a: 1, b: [1, 2, 3] })).toBe(true);  // scalar in array
        expect(t("in(a, b)", { a: "x", b: { x: 1 } })).toBe(true); // scalar in hash
        expect(t("in(a, b)", { a: 1, b: 2 })).toBe(false);
    });

    test("conditions: MARC (marc_any_match, marc_all_match, marc_has_many)", () => {
        const rec = {
            record: [
                ["245", "1", "0", "a", "Perl Programming"],
                ["500", " ", " ", "a", "x"], ["500", " ", " ", "a", "y"],
                ["100", " ", " ", "a", "Wall"],
            ],
        };
        const t = (cond: string) => "m" in compileFix(`if ${cond} add_field(m, Y) end`)(structuredClone(rec));
        expect(t("marc_any_match(245a, Perl)")).toBe(true);
        expect(t("marc_all_match(500a, x)")).toBe(false);   // not all 500$a == x
        expect(t("marc_has_many(500)")).toBe(true);          // 500 appears twice
        expect(t("marc_has_many(245)")).toBe(false);         // 245 once
    });

    test("genid", () => {
        const out = buildFix("genid", ["x"])({});
        expect(out.x).toMatch(/^genid:[0-9a-f-]{36}$/);
        // fresh id per wildcard slot
        const out2 = compileFix("genid(items.*.id)")({ items: [{}, {}] });
        expect(out2.items[0].id).not.toBe(out2.items[1].id);
    });

    test("lookup / retain / retain_field / substring / sort_field / uniq / vacuum", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        const csv = path.join(os.tmpdir(), `marcattacks-fixtest-${process.pid}.csv`);
        fs.writeFileSync(csv, "Earth,Terra\nMars,Ares\n");
        try {
            // lookup
            expect(run(`lookup(planet, ${csv})`, { planet: "Earth" })).toEqual({ planet: "Terra" });
            expect(run(`lookup(planet, ${csv})`, { planet: "Pluto" })).toEqual({ planet: "Pluto" });
            expect(run(`lookup(planet, ${csv}, default, X)`, { planet: "Pluto" })).toEqual({ planet: "X" });
            expect(run(`lookup(planet, ${csv}, delete, 1)`, { planet: "Pluto" })).toEqual({});
            expect(run(`lookup(planets.*, ${csv}, delete, 1)`, { planets: ["Pluto", "Earth"] })).toEqual({ planets: ["Terra"] });
        } finally {
            fs.unlinkSync(csv);
        }
        // retain / retain_field
        expect(run("retain(a, c)", { a: 1, b: 2, c: 3 })).toEqual({ a: 1, c: 3 });
        expect(run("retain_field(foo.bar)", { foo: { bar: 1, baz: 2, qux: 3 } })).toEqual({ foo: { bar: 1 } });
        // substring
        expect(run("substring(s, 0, 3)", { s: "abcdefg" })).toEqual({ s: "abc" });
        expect(run("substring(s, 2)", { s: "abcdefg" })).toEqual({ s: "cdefg" });
        // sort_field / uniq
        expect(run("sort_field(tags)", { tags: ["foo", "bar", "bar"] })).toEqual({ tags: ["bar", "bar", "foo"] });
        expect(run("sort_field(tags, uniq, 1)", { tags: ["foo", "bar", "bar"] })).toEqual({ tags: ["bar", "foo"] });
        expect(run("sort_field(nums, numeric, 1)", { nums: [100, 1, 10] })).toEqual({ nums: [1, 10, 100] });
        expect(run("uniq(tags)", { tags: ["foo", "bar", "bar", "foo"] })).toEqual({ tags: ["foo", "bar"] });
        // vacuum
        expect(run("vacuum()", { a: "x", b: "", c: [], d: {}, e: null, f: { g: "" }, h: ["", 1] }))
            .toEqual({ a: "x", h: [1] });
    });

    test("format / count / set_array / set_hash / from_json / to_json", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        expect(run('format(n, "%-10.10d")', { n: 41 })).toEqual({ n: "0000000041" });
        expect(run('format(n, "%05.2f")', { n: 3.14159 })).toEqual({ n: "03.14" });
        expect(run('format(s, "[%s]")', { s: "hi" })).toEqual({ s: "[hi]" });
        expect(run("count(tags)", { tags: ["a", "b", "c"] })).toEqual({ tags: 3 });
        expect(run("count(h)", { h: { a: 1, b: 2 } })).toEqual({ h: 2 });
        expect(run("set_array(foo, a, b, c)", {})).toEqual({ foo: ["a", "b", "c"] });
        expect(run("set_hash(foo, a, 1, b, 2)", {})).toEqual({ foo: { a: "1", b: "2" } });
        expect(run("from_json(j)", { j: '{"a":[1,2]}' })).toEqual({ j: { a: [1, 2] } });
        expect(run("to_json(j)", { j: { a: [1, 2] } })).toEqual({ j: '{"a":[1,2]}' });
    });

    test("rename / filter / flatten / collapse / expand", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        expect(run('rename(d, "\\\\.", "-")', { d: { "ns.foo": "v", x: { "ns.bar": "w" } } }))
            .toEqual({ d: { "ns-foo": "v", x: { "ns-bar": "w" } } });
        expect(run('filter(words, "Pa")', { words: ["Patrick", "Nicolas", "Paul"] }))
            .toEqual({ words: ["Patrick", "Paul"] });
        expect(run('filter(words, "Pa", invert, 1)', { words: ["Patrick", "Nicolas", "Paul"] }))
            .toEqual({ words: ["Nicolas"] });
        expect(run("flatten(deep)", { deep: [1, [2, 3], 4, [5, [6, 7]]] }))
            .toEqual({ deep: [1, 2, 3, 4, 5, 6, 7] });
        expect(run("collapse()", { a: { b: 1 }, c: [10, 20] }))
            .toEqual({ "a.b": 1, "c.0": 10, "c.1": 20 });
        expect(run("expand()", { "a.b": 1, "c.0": 10, "c.1": 20 }))
            .toEqual({ a: { b: 1 }, c: [10, 20] });
    });

    test("parse_text / int / string / uri_encode / uri_decode / compact / expand_date", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // parse_text: numbered groups -> array, named groups -> hash
        expect(run('parse_text(d, "(\\\\d\\\\d\\\\d\\\\d)-(\\\\d\\\\d)-(\\\\d\\\\d)")', { d: "2015-03-07" }))
            .toEqual({ d: ["2015", "03", "07"] });
        expect(run('parse_text(d, "(?<year>\\\\d{4})-(?<month>\\\\d{2})")', { d: "2015-03" }))
            .toEqual({ d: { year: "2015", month: "03" } });
        // int
        expect(run("int(y)", { y: "2016" })).toEqual({ y: 2016 });
        expect(run("int(y)", { y: "bar-123baz" })).toEqual({ y: -123 });
        expect(run("int(y)", { y: "" })).toEqual({ y: 0 });
        expect(run("int(a)", { a: ["x", "y"] })).toEqual({ a: 2 });
        // string
        expect(run("string(y)", { y: 2016 })).toEqual({ y: "2016" });
        expect(run("string(foo)", { foo: ["a", "b", "c"] })).toEqual({ foo: "abc" });
        // uri_encode / uri_decode
        expect(run("uri_encode(s)", { s: "café x/y!" })).toEqual({ s: "caf%C3%A9%20x%2Fy%21" });
        expect(run("uri_decode(s)", { s: "caf%C3%A9%20x%2Fy%21" })).toEqual({ s: "café x/y!" });
        // compact
        expect(run("compact(list)", { list: [null, "hello", null, "world"] })).toEqual({ list: ["hello", "world"] });
        // expand_date
        expect(run("expand_date()", { date: "2001-09-11" }))
            .toEqual({ date: "2001-09-11", year: "2001", month: 9, day: 11 });
        expect(run("expand_date(datestamp)", { datestamp: "2001:09" }))
            .toEqual({ datestamp: "2001:09", year: "2001", month: 9 });
    });

    test("datetime_format (Catmandu::Fix::Date)", () => {
        const run = (src: string, data: any) => compileFix(src)(structuredClone(data));
        // pull the year out of a packed date (the bl_ugent_memorialis idiom)
        expect(run("datetime_format(d, source_pattern: '%Y%m%d', destination_pattern: '%Y')", { d: "19501231" }))
            .toEqual({ d: "1950" });
        // ISO datetime -> dd/mm/yyyy
        expect(run("datetime_format(d, source_pattern: '%Y-%m-%dT%H:%M:%S', destination_pattern: '%d/%m/%Y')", { d: "2015-03-07T00:00:00" }))
            .toEqual({ d: "07/03/2015" });
        // operates on the addressed element only ($first)
        expect(run("datetime_format(d.$first, source_pattern: '%Y%m%d', destination_pattern: '%Y')", { d: ["19501231", "keep"] }))
            .toEqual({ d: ["1950", "keep"] });
        // month name parsing + composite %F destination
        expect(run("datetime_format(d, source_pattern: '%d %B %Y', destination_pattern: '%F')", { d: "07 March 2015" }))
            .toEqual({ d: "2015-03-07" });
        // destination_pattern defaults to source_pattern (round-trip / normalise)
        expect(run("datetime_format(d, source_pattern: '%Y-%m-%d')", { d: "2015-03-07" }))
            .toEqual({ d: "2015-03-07" });
        // unparseable value: left untouched by default, dropped with delete:1
        expect(run("datetime_format(d, source_pattern: '%Y%m%d', destination_pattern: '%Y')", { d: "unknown" }))
            .toEqual({ d: "unknown" });
        expect(run("datetime_format(d, source_pattern: '%Y%m%d', destination_pattern: '%Y', delete: 1)", { d: "unknown" }))
            .toEqual({});
    });

    test("paste", () => {
        expect(fix("paste", ["my.string", "a", "b", "c", "d"], { a: "eeny", b: "meeny", c: "miny", d: "moe" }))
            .toMatchObject({ my: { string: "eeny meeny miny moe" } });
        expect(fix("paste", ["my.string", "a", "b", "join_char", ", "], { a: "eeny", b: "meeny" }))
            .toMatchObject({ my: { string: "eeny, meeny" } });
    });
});
