import { test } from "node:test";
import assert from "node:assert/strict";
import { merge3Text } from "../src/engine/merge.ts";

const base = "one\ntwo\nthree\nfour\n";
test("edits in different places combine", () => {
	const m = merge3Text(base, base.replace("one", "ONE"), base.replace("four", "FOUR"));
	assert.deepEqual(m, { ok: true, text: "ONE\ntwo\nthree\nFOUR\n" });
});
test("both sides appending at different ends combine", () => {
	assert.deepEqual(merge3Text(base, "top\n" + base, base + "bottom\n"), { ok: true, text: "top\n" + base + "bottom\n" });
});
test("the same change on both sides is applied once", () => {
	assert.deepEqual(merge3Text(base, base.replace("two", "2"), base.replace("two", "2")), { ok: true, text: base.replace("two", "2") });
	assert.deepEqual(merge3Text(base, base.replace("two", "2"), base.replace("two", "2").replace("four", "4")), { ok: true, text: base.replace("two", "2").replace("four", "4") });
});
test("overlapping, touching or disagreeing edits are refused", () => {
	assert.equal(merge3Text(base, base.replace("two", "TWO"), base.replace("two", "2")).ok, false);
	assert.equal(merge3Text(base, base.replace("two", "TWO"), base.replace("TWO".length ? "two\nthree" : "", "x")).ok, false);
	assert.equal(merge3Text(base, base + "a", base + "b").ok, false);
});
test("one side unchanged returns the other, byte for byte", () => {
	assert.deepEqual(merge3Text(base, base, "x" + base), { ok: true, text: "x" + base });
	assert.deepEqual(merge3Text(base, "x" + base, base), { ok: true, text: "x" + base });
});
