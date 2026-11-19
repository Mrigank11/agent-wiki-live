import type * as Y from "yjs";
import { diffEdits, merge3Text } from "./merge.ts";
import { ORIGIN_DISK, type DiskPort, type Hooks, type LiveNote, type NoteRecord } from "./types.ts";

/** Applies the smallest edits that turn the Y.Text into `to`, as one transaction: never delete-all-and-reinsert. */
export function setText(doc: Y.Doc, text: Y.Text, to: string, origin: unknown = ORIGIN_DISK) {
	const from = text.toString();
	const edits = diffEdits(from, to);
	if (!edits.length) return false;
	doc.transact(() => {
		for (let i = edits.length - 1; i >= 0; i--) {
			const e = edits[i];
			if (e.del) text.delete(e.pos, e.del);
			if (e.ins) text.insert(e.pos, e.ins);
		}
	}, origin);
	return true;
}

/** How many past live texts an open note remembers, and the most characters they may add up to. */
const RECENT_TEXTS = 32;
const RECENT_CHARS = 2_000_000;

/**
 * One note: keeps its file and its live text in agreement. `base` is the last text known to be on
 * disk and live at once; every decision is a three-way merge against it. All calls are made one at a
 * time by VaultSync, so nothing here races.
 */
export class NoteSync {
	path: string;
	base: string | null;
	/** The last text we wrote to disk ourselves: the file event it causes is our own echo. */
	private wrote: string | null = null;
	/**
	 * The last few live texts of an open note, newest last. Obsidian saves the editor's text some time after it was
	 * typed, so a file read can show a text the live note has already moved past: that is Obsidian's own save, not an
	 * outside edit.
	 */
	private recent: string[] = [];
	private timer: ReturnType<typeof setTimeout> | null = null;
	private off: () => void;
	private dead = false;

	readonly id: string;
	readonly live: LiveNote;
	private disk: DiskPort;
	private hooks: Hooks;
	/** Ask the owner to run `fn` in the vault's one-at-a-time queue. */
	private enqueue: (fn: () => Promise<void>) => void;
	/** Keep a person's text that cannot merge as a note of its own. */
	private keepLocalCopy: (path: string, text: string) => Promise<void>;
	private opts: { settleMs: number; readOnly: boolean; isOpen: (path: string) => boolean; changed: () => void; status: () => void };

	constructor(
		id: string,
		record: NoteRecord | undefined,
		live: LiveNote,
		disk: DiskPort,
		hooks: Hooks,
		enqueue: (fn: () => Promise<void>) => void,
		keepLocalCopy: (path: string, text: string) => Promise<void>,
		opts: { settleMs: number; readOnly: boolean; isOpen: (path: string) => boolean; changed: () => void; status: () => void },
	) {
		this.id = id;
		this.live = live;
		this.disk = disk;
		this.hooks = hooks;
		this.enqueue = enqueue;
		this.keepLocalCopy = keepLocalCopy;
		this.opts = opts;
		this.path = record?.path ?? "";
		this.base = record ? record.base : null;
		const obs = (_e: unknown, tr: Y.Transaction) => {
			this.remember();
			if (tr.origin === ORIGIN_DISK) return;
			this.scheduleWrite();
			this.opts.status();
		};
		live.text.observe(obs as any);
		this.off = () => live.text.unobserve(obs as any);
		this.remember();
	}

	/** Keep the live text in the bounded history (open notes only, so closed notes cost nothing). */
	private remember() {
		if (!this.opts.isOpen(this.path)) return this.recent.length && (this.recent = []);
		const t = this.text;
		if (this.recent[this.recent.length - 1] === t) return;
		this.recent.push(t);
		let size = 0;
		for (let i = this.recent.length - 1; i >= 0; i--) {
			size += this.recent[i].length;
			if (this.recent.length - i > RECENT_TEXTS || (size > RECENT_CHARS && i < this.recent.length - 1)) {
				this.recent.splice(0, i + 1);
				break;
			}
		}
	}

	get text() {
		return this.live.text.toString();
	}

	/** The live text has not been written to the file yet. */
	get fileBehind() {
		return this.timer !== null;
	}

	record(): NoteRecord | null {
		return this.base === null ? null : { path: this.path, base: this.base };
	}

	private scheduleWrite() {
		if (this.dead) return;
		if (this.timer) clearTimeout(this.timer);
		const wait = this.opts.isOpen(this.path) ? this.opts.settleMs * 6 : this.opts.settleMs;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.enqueue(() => this.settle());
		}, wait);
	}

	/** First attach and every later pass: look at the file and the live text and bring them together. */
	async reconcile(path: string) {
		this.path = path;
		const disk = await this.disk.read(path);
		await this.compare(disk);
	}

	/** The file changed (Obsidian's save, an outside write, a sync tool). */
	async onDisk(disk: string | null) {
		if (disk !== null && disk === this.wrote) {
			this.wrote = null;
			if (this.base === null || disk === this.text) this.adopt(disk);
			return;
		}
		await this.compare(disk);
	}

	private adopt(text: string) {
		if (this.base !== text) {
			this.base = text;
			this.opts.changed();
		}
	}

	private async compare(disk: string | null) {
		const live = this.text;
		if (disk === null) return this.writeLive();
		if (disk === live) return this.adopt(live);
		// Obsidian saved a text the editor has typed past: its own save, not an outside edit; the newer live text is written later
		if (this.opts.isOpen(this.path) && this.recent.includes(disk)) {
			this.adopt(disk);
			return this.scheduleWrite();
		}
		if (this.opts.readOnly) return; // never push a read-only person's file edits into live text
		if (this.base === null) return this.divergent(disk); // first attach, texts differ: nothing is overwritten
		const m = merge3Text(this.base, disk, live);
		if (!m.ok) return this.divergent(disk);
		if (m.text !== live) setText(this.live.doc, this.live.text, m.text);
		if (m.text === disk) return this.adopt(m.text);
		// an open note is saved by Obsidian from the editor, which holds this text: write later, only if it does not
		if (this.opts.isOpen(this.path)) return this.scheduleWrite();
		await this.writeDisk(m.text);
	}

	/** The file and the live text both changed in the same place: live stays, the file's text is kept as its own note. */
	private async divergent(disk: string) {
		await this.keepLocalCopy(this.path, disk);
		await this.writeDisk(this.text);
	}

	/** Remote changes settled: put the live text on disk unless an outside edit has to be merged first. */
	async settle() {
		if (this.dead) return;
		const disk = await this.disk.read(this.path);
		if (disk !== null && disk !== this.base && disk !== this.text) return this.compare(disk);
		await this.writeLive(disk);
	}

	private async writeLive(known?: string | null) {
		const live = this.text;
		const disk = known === undefined ? await this.disk.read(this.path) : known;
		if (disk === live) return this.adopt(live);
		await this.writeDisk(live);
	}

	private async writeDisk(text: string) {
		this.wrote = text;
		await this.disk.write(this.path, text);
		this.base = text;
		this.opts.changed();
	}

	/** Where the file now is (a rename on either side). */
	moved(path: string) {
		this.path = path;
		this.opts.changed();
	}

	destroy() {
		this.dead = true;
		if (this.timer) clearTimeout(this.timer);
		this.off();
		this.live.destroy();
	}
}
