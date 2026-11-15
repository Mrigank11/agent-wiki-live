import fast from "fast-diff";

export type Edit = { pos: number; del: number; ins: string };

/** The smallest character edits that turn a into b; positions refer to a, ascending. */
export function diffEdits(a: string, b: string): Edit[] {
	if (a === b) return [];
	const edits: Edit[] = [];
	let pos = 0;
	let cur: Edit | null = null;
	for (const [op, text] of fast(a, b)) {
		if (op === fast.EQUAL) {
			if (cur) edits.push(cur);
			cur = null;
			pos += text.length;
		} else {
			cur ??= { pos, del: 0, ins: "" };
			if (op === fast.DELETE) {
				cur.del += text.length;
				pos += text.length;
			} else cur.ins += text;
		}
	}
	if (cur) edits.push(cur);
	return edits;
}

export type Merged = { ok: true; text: string } | { ok: false };

/**
 * Three-way merge of two edits of `base`: `disk` (a person or program wrote the file) and `live`
 * (what the server has). Each side's edits are found as a character diff against `base`; edits that
 * do not touch each other are both applied, and anything that overlaps, touches or disagrees is
 * `ok: false`, so the caller keeps both texts. It refuses to guess.
 */
export function merge3Text(base: string, disk: string, live: string): Merged {
	if (disk === live) return { ok: true, text: live };
	if (live === base) return { ok: true, text: disk };
	if (disk === base) return { ok: true, text: live };
	const a = diffEdits(base, disk);
	const b = diffEdits(base, live);
	const all: (Edit & { side: 0 | 1 })[] = [...a.map((e) => ({ ...e, side: 0 as const })), ...b.map((e) => ({ ...e, side: 1 as const }))].sort((x, y) => x.pos - y.pos || x.side - y.side);
	const out: Edit[] = [];
	for (const e of all) {
		const prev = out[out.length - 1];
		if (prev) {
			const prevEnd = prev.pos + prev.del;
			const same = prev.pos === e.pos && prev.del === e.del && prev.ins === e.ins;
			if (same) continue; // both sides made exactly this change
			if (e.pos <= prevEnd) return { ok: false }; // overlapping or touching: not safe to combine
		}
		out.push({ pos: e.pos, del: e.del, ins: e.ins });
	}
	let text = "";
	let at = 0;
	for (const e of out) {
		text += base.slice(at, e.pos) + e.ins;
		at = e.pos + e.del;
	}
	return { ok: true, text: text + base.slice(at) };
}
