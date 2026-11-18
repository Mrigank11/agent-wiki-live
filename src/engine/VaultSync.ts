import type * as Y from "yjs";
import { NoteSync } from "./NoteSync.ts";
import type { DiskPort, Hooks, IndexEntry, LiveNote, NoteRecord, RemotePort, StatePort } from "./types.ts";

export type VaultSyncOptions = {
	settleMs?: number;
	isOpen?: (path: string) => boolean;
	/**
	 * Day 1 connects only an empty folder. Merging a folder that already holds notes (adopt identical
	 * files, upload new ones, keep differing ones as local copies) is built and tested but switched off
	 * until it has had more use; the plugin never sets this.
	 */
	adoptExisting?: boolean;
	/** Names this device in conflict copies ("laptop", "phone"). */
	device?: string;
	/** The clock for conflict copy names. */
	now?: () => Date;
};

/** A note's name without what earlier conflicts or clashes added: a copy is always a copy of the note itself. */
const SUFFIXES = /(?: \((?:conflict [^)]*|local copy(?: \d+)?|\d+)\))+$/;
export const baseStem = (path: string) => path.replace(/\.md$/, "").replace(SUFFIXES, "");
const pad = (n: number) => String(n).padStart(2, "0");

/** How many notes are opened (their sync asked of the server) at once while attaching a vault. */
export const ATTACH_WINDOW = 64;

export class NonEmptyFolderError extends Error {
	constructor() {
		super("This folder already has notes in it. Connect an empty (new) folder to an agent-wiki vault: create a new vault in Obsidian and enable the plugin there.");
		this.name = "NonEmptyFolderError";
	}
}

/**
 * Keeps a whole vault in step with its live vault: the file tree (the index) and every note.
 * Everything runs through one queue, so the engine never races itself. Nothing is overwritten:
 * a file that cannot merge is kept as a note of its own, and a deletion never wins over text that
 * changed on the other side.
 */
export class VaultSync {
	private notes = new Map<string, NoteSync>(); // id -> note
	private byPath = new Map<string, string>(); // path -> id
	private records: Record<string, NoteRecord>;
	private queue: Promise<void> = Promise.resolve();
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	private settleMs: number;
	private readonly onIndex: (e: Y.YMapEvent<IndexEntry>, tr: Y.Transaction) => void;
	private unlistenResync: (() => void) | null = null;
	/** The first full attach: the first index pass and the one after it. */
	private firstPass: Promise<void> = Promise.resolve();
	/** Notes asked of the server whose answer has not been taken yet; stopping closes them. */
	private opening = new Set<LiveNote>();
	/** Notes this device renamed whose rename the server has not accepted yet (offline): the index's old path is not a remote move. */
	private unsentMoves = new Set<string>();
	/** Paths we are creating or moving ourselves, so the file event they raise is not taken as a person's edit. */
	private quiet = new Set<string>();
	/** What we wrote to files that were not yet notes (local copies): a file event for exactly this text is our own echo, whenever it arrives. */
	private echoes = new Map<string, string>();

	private disk: DiskPort;
	private remote: RemotePort;
	private state: StatePort;
	private hooks: Hooks;
	private opts: VaultSyncOptions;

	constructor(disk: DiskPort, remote: RemotePort, state: StatePort, hooks: Hooks, opts: VaultSyncOptions = {}) {
		this.disk = disk;
		this.remote = remote;
		this.state = state;
		this.hooks = hooks;
		this.opts = opts;
		this.records = { ...state.load() };
		this.settleMs = opts.settleMs ?? 400;
		this.onIndex = (_e, tr) => {
			if (this.stopped) return;
			this.enqueue(() => this.syncIndex());
		};
	}

	private pausedUntil = 0;

	/** Create a note on the server. When the server refuses a burst (429: something is creating copies in a loop), stop creating for a minute and say so once. */
	private async createNote(path: string, text: string) {
		if (Date.now() < this.pausedUntil) return;
		try {
			return await this.remote.createFile(path, text);
		} catch (e) {
			if ((e as { status?: number })?.status !== 429) throw e;
			this.pausedUntil = Date.now() + 60_000;
			this.hooks.notify({ kind: "error", message: "agent-wiki refused new notes because too many identical ones were being created in a row. The plugin has paused creating notes for a minute; if this repeats, disconnect and check for a loop." });
		}
	}

	private enqueue(fn: () => Promise<void>) {
		this.queue = this.queue.then(fn).catch((e) => this.hooks.log?.("engine error", String(e?.stack ?? e)));
		return this.queue;
	}

	/** Resolves when every queued step has run (for tests and for "idle" in the status bar). */
	idle() {
		return this.queue;
	}

	/**
	 * Checks the folder and queues the first pass over the vault. Resolves as soon as that is queued: the vault is
	 * usable at once, and its notes attach in the background (`attached()` says when they all have, `Hooks.progress` how far).
	 */
	async start() {
		// a folder is "ours" once we remember notes in it, or were here before and remember none (stopped while filling an empty folder)
		const resumed = Object.keys(this.records).length > 0 || this.state.started?.() === true;
		if (!this.opts.adoptExisting && !resumed && (await this.disk.list()).length > 0) throw new NonEmptyFolderError();
		if (!resumed && this.state.flush) {
			// mark the folder as ours before the first note is written to it: a kill in the middle of the first fill must not turn the next start into "this folder already has notes"
			this.state.save({});
			await this.state.flush().catch((e) => this.hooks.log?.("could not mark the folder", String(e)));
		}
		const first = this.enqueue(() => this.syncIndex(true));
		this.remote.index.observe(this.onIndex as any);
		// back online after a break: what was deleted, renamed or created here meanwhile has not reached the server yet
		this.unlistenResync = this.remote.onResync?.(() => void this.onEvent(() => this.syncIndex())) ?? null;
		// notes created during the first pass (files the server did not know) were not observed yet: attach them
		this.firstPass = first.then(() => this.enqueue(() => this.syncIndex()));
	}

	/** Resolves when the first full attach is done: every note the server had is open and settled. */
	attached(): Promise<void> {
		return this.firstPass;
	}

	stop() {
		this.stopped = true;
		this.unlistenResync?.();
		this.remote.index.unobserve(this.onIndex as any);
		this.saveNow(); // before the notes go: what we remember is what they know
		for (const l of this.opening) l.destroy();
		this.opening.clear();
		for (const n of this.notes.values()) n.destroy();
		this.notes.clear();
	}

	// ---------------------------------------------------------------- the file tree

	private entries(): Map<string, IndexEntry> {
		const out = new Map<string, IndexEntry>();
		this.remote.index.forEach((v, id) => out.set(id, v));
		return out;
	}

	/** Index and disk, side by side: attach what the server has, create what only we have, follow renames and deletes. */
	private async syncIndex(first = false) {
		if (this.stopped) return;
		const entries = this.entries();
		const localPaths = new Set(await this.disk.list());
		const claimed = new Set<string>();
		// files on disk that no note, in the index or remembered, accounts for: where a note renamed while we were away may now be
		const unknown = new Set(localPaths);
		for (const e of entries.values()) if (!e.deleted) unknown.delete(e.path);
		for (const r of Object.values(this.records)) unknown.delete(r.path);
		for (const n of this.notes.values()) unknown.delete(n.path);

		const toAttach: { id: string; path: string }[] = [];
		for (const [id, e] of entries) {
			if (e.deleted) {
				await this.remoteDeleted(id);
				continue;
			}
			claimed.add(e.path);
			const known = this.notes.get(id);
			if (known) {
				if (this.unsentMoves.has(id)) {
					// renamed here while the server could not be told: tell it now instead of undoing the rename
					if (e.path !== known.path) await this.sendMove(id, e.path, known.path);
					if (this.unsentMoves.has(id)) continue;
				} else if (known.path !== e.path) {
					await this.remoteMoved(id, known, e.path);
					continue;
				}
				if (!localPaths.has(known.path) && !this.quiet.has(known.path)) await this.deletedHere(id, known);
				continue;
			}
			const at = await this.prepareAttach(id, e.path, localPaths, claimed, unknown);
			if (at !== null) toAttach.push({ id, path: at });
		}
		await this.attachAll(toAttach, localPaths);
		if (this.stopped) return;

		// files on disk the server does not know
		for (const p of localPaths) {
			if (claimed.has(p) || this.quiet.has(p)) continue;
			if (this.echoes.has(p) && (await this.disk.read(p)) === this.echoes.get(p)) continue;
			const was = Object.entries(this.records).find(([, r]) => r.path === p);
			if (was && !entries.has(was[0])) {
				// We knew it and the server has forgotten it entirely (a deletion older than its tombstones). Unchanged
				// here since: it was deleted while this device was away, so it goes. Edited here: the edit is kept as a new note.
				delete this.records[was[0]];
				const mine = await this.disk.read(p);
				if (mine !== null && mine === was[1].base && !this.remote.readOnly) {
					this.quiet.add(p);
					await this.disk.remove(p);
					this.quiet.delete(p);
					continue;
				}
			}
			if (this.remote.readOnly) continue;
			const text = await this.disk.read(p);
			if (text === null) continue;
			await this.createNote(p, text); // the index observer attaches it
		}

		// notes we knew that are gone from the index and from disk
		for (const id of Object.keys(this.records)) {
			if (!entries.has(id) && !this.notes.has(id)) delete this.records[id];
		}
		this.saveSoon();
	}

	/** The one file in `unknown` whose text is exactly `base`: a note renamed while Obsidian was closed (a rename is not told, only found). */
	private async renamedTo(base: string, unknown: Set<string>) {
		if (!base.trim()) return null;
		let found: string | null = null;
		for (const p of unknown) {
			if ((await this.disk.read(p)) !== base) continue;
			if (found) return null; // two candidates: cannot tell which
			found = p;
		}
		return found;
	}

	/**
	 * Before a note is opened: a note renamed while Obsidian was closed is found and the server told. Returns the path
	 * the note is at now, or null when it cannot be attached yet (the server refused the rename; it is retried).
	 */
	private async prepareAttach(id: string, path: string, localPaths: Set<string>, claimed: Set<string>, unknown: Set<string>): Promise<string | null> {
		const rec0 = this.records[id];
		if (rec0 && rec0.path === path && !localPaths.has(path) && !this.remote.readOnly) {
			// gone from where we left it, and a file with exactly its text turned up elsewhere: it was renamed
			const to = await this.renamedTo(rec0.base, unknown);
			const alike = Object.entries(this.records).filter(([k, r]) => k !== id && r.base === rec0.base && !localPaths.has(r.path));
			if (to && alike.length === 0) {
				unknown.delete(to);
				claimed.add(to);
				try {
					await this.remote.moveFile(path, to);
				} catch (e) {
					this.hooks.log?.("rename while closed: server refused, will retry", String(e));
					return null;
				}
				this.records[id] = { path: to, base: rec0.base };
				path = to;
			}
		}
		return path;
	}

	/**
	 * Opens the notes `ATTACH_WINDOW` at a time: each window's sync is asked of the server at once (a round trip per
	 * window, not per note), then its notes are settled one by one. The next window is asked for as soon as this one
	 * has answered, so its round trip overlaps with settling this one's notes (never more than one window is unanswered).
	 * File events wait in the queue behind this, so an edit to a note that is not attached yet is merged when it is.
	 */
	private async attachAll(items: { id: string; path: string }[], localPaths: Set<string>) {
		try {
			await this.attachWindows(items, localPaths);
		} catch (e) {
			// the attach is over: let go of the windows asked for, and say so, so that no screen keeps counting up to a total it will not reach
			for (const live of this.opening) live.destroy();
			this.opening.clear();
			const why = (e as Error)?.message ?? String(e);
			this.hooks.attachFailed?.(why);
			this.hooks.notify({ kind: "error", message: `agent-wiki could not open all your notes (${why}). The vault is live; Reconnect to try the rest again.` });
			throw e;
		}
	}

	private async attachWindows(items: { id: string; path: string }[], localPaths: Set<string>) {
		const total = items.length;
		if (!total || this.stopped) return;
		this.hooks.progress?.(0, total);
		const ask = (from: number) => {
			const win = items.slice(from, from + ATTACH_WINDOW);
			const lives = win.map((a) => {
				const live = this.remote.openNote(a.id);
				this.opening.add(live);
				return live;
			});
			return { win, lives, answered: Promise.all(lives.map((l) => l.synced)) };
		};
		let done = 0;
		let cur = ask(0);
		for (let i = 0; i < total; i += ATTACH_WINDOW) {
			await cur.answered;
			const now = cur;
			cur = i + ATTACH_WINDOW < total && !this.stopped ? ask(i + ATTACH_WINDOW) : now;
			for (let k = 0; k < now.win.length; k++) {
				const wasOpen = this.opening.delete(now.lives[k]);
				if (this.stopped) {
					if (wasOpen) now.lives[k].destroy();
					continue;
				}
				await this.finishAttach(now.win[k].id, now.win[k].path, now.lives[k], localPaths);
				this.hooks.progress?.(++done, total);
			}
			if (this.stopped) return;
		}
	}

	/** After a note's sync: decide what is where, and bring file and live text into agreement. */
	private async finishAttach(id: string, path: string, live: LiveNote, localPaths: Set<string>) {
		const rec = this.records[id];
		const n = new NoteSync(id, rec, live, this.disk, this.hooks, (fn) => void this.enqueue(fn), (p, t) => this.keepLocalCopy(p, t), {
			settleMs: this.settleMs,
			readOnly: this.remote.readOnly,
			isOpen: this.opts.isOpen ?? (() => false),
			changed: () => this.saveSoon(),
		});
		this.notes.set(id, n);
		this.byPath.set(path, id);

		// where the file is: where the index says; if we knew it elsewhere and it is still there, it was renamed while we were away
		if (rec && rec.path !== path && !localPaths.has(path) && localPaths.has(rec.path)) {
			this.quiet.add(path);
			await this.disk.rename(rec.path, path);
			this.quiet.delete(path);
			localPaths.delete(rec.path);
			localPaths.add(path);
		}
		if (rec && !localPaths.has(path)) {
			// the file is gone from disk
			if (live.text.toString() === rec.base) {
				// nobody else changed it: the deletion is the person's
				if (!this.remote.readOnly) {
					await this.remote.deleteFile(path);
					n.destroy();
					this.notes.delete(id);
					this.byPath.delete(path);
					delete this.records[id];
					return;
				}
			} else this.hooks.notify({ kind: "restored", message: `"${path}" was deleted here but changed elsewhere; restored.` });
		}
		await n.reconcile(path);
	}

	/** A note's file is gone from disk while the server still lists it: a delete the server was never told. A deletion never beats text that changed elsewhere. */
	private async deletedHere(id: string, n: NoteSync) {
		if (this.remote.readOnly || n.text !== n.base) {
			await n.onDisk(null); // brings the file back
			return;
		}
		try {
			await this.remote.deleteFile(n.path);
		} catch (e) {
			this.hooks.log?.("delete: server not reachable, will retry", String(e));
		}
	}

	/** Tell the server a rename made here; if it cannot be reached it stays remembered and is retried when the index next syncs. */
	private async sendMove(id: string, from: string, to: string) {
		try {
			await this.remote.moveFile(from, to);
			this.unsentMoves.delete(id);
		} catch (e) {
			this.unsentMoves.add(id);
			this.hooks.log?.("rename: server not reachable, will retry", String(e));
		}
	}

	private async remoteDeleted(id: string) {
		const n = this.notes.get(id);
		const rec = this.records[id];
		const path = n?.path ?? rec?.path;
		if (!path) return;
		const disk = await this.disk.read(path);
		const base = n?.base ?? rec?.base ?? null;
		n?.destroy();
		this.notes.delete(id);
		this.byPath.delete(path);
		delete this.records[id];
		if (disk === null) return;
		const unsent = (n?.live.unsynced?.() ?? 0) > 0; // our own edits the server never saw
		if (base !== null && disk === base && !unsent) {
			this.quiet.add(path);
			await this.disk.remove(path);
			this.quiet.delete(path);
		} else if (!this.remote.readOnly) {
			// deleted on the server but edited here: keep the file, it becomes a new note
			this.hooks.notify({ kind: "restored", message: `"${path}" was deleted elsewhere but you changed it here; kept.` });
			await this.createNote(path, disk);
		}
		this.saveSoon();
	}

	private async remoteMoved(id: string, n: NoteSync, to: string) {
		const from = n.path;
		this.byPath.delete(from);
		this.byPath.set(to, id);
		if ((await this.disk.read(from)) !== null) {
			if ((await this.disk.read(to)) === null) {
				this.quiet.add(to);
				await this.disk.rename(from, to);
				this.quiet.delete(to);
			}
		}
		n.moved(to);
	}

	/**
	 * Keep text that could not merge as a note of its own: `<note> (conflict <device> <date time>).md`, named
	 * from the note itself (never from another copy), skipped when an identical copy already exists, and
	 * checked against this disk and the live index so the server never has to rename it.
	 */
	private async keepLocalCopy(path: string, text: string) {
		if (this.remote.readOnly) return;
		const stem = baseStem(path);
		const taken = new Set(await this.disk.list());
		for (const p of this.byPath.keys()) taken.add(p);
		this.remote.index.forEach((e) => {
			if (!e.deleted) taken.add(e.path);
		});
		for (const p of taken) {
			if (p.startsWith(`${stem} (conflict `) && (await this.disk.read(p)) === text) {
				this.hooks.notify({ kind: "local-copy", message: `"${path}" changed here and elsewhere at once. The shared text is kept; your version is already saved as "${p}".` });
				return;
			}
		}
		const d = (this.opts.now ?? (() => new Date()))();
		const when = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
		const base = `${stem} (conflict ${this.opts.device ?? "device"} ${when}`;
		let name = `${base}).md`;
		for (let i = 2; taken.has(name); i++) name = `${base} ${i}).md`;
		this.echoes.set(name, text);
		await this.disk.write(name, text);
		await this.createNote(name, text);
		this.hooks.notify({ kind: "local-copy", message: `"${path}" changed here and elsewhere at once. The shared text is kept; your version is saved as "${name}".` });
	}

	// ---------------------------------------------------------------- what Obsidian tells us

	/** Queue a reaction to a vault event. A stopped engine reacts to nothing: it no longer owns the connection. */
	private onEvent(fn: () => Promise<void>) {
		return this.enqueue(async () => {
			if (!this.stopped) await fn();
		});
	}

	/** A file was written (a save, an outside edit, a sync tool). */
	fileChanged(path: string) {
		return this.onEvent(async () => {
			if (this.quiet.has(path)) return;
			const id = this.byPath.get(path);
			const disk = await this.disk.read(path);
			if (!id) {
				if (disk !== null && disk === this.echoes.get(path)) return; // our own write
				if (disk !== null && !this.remote.readOnly) await this.createNote(path, disk);
				return;
			}
			this.echoes.delete(path);
			await this.notes.get(id)!.onDisk(disk);
		});
	}

	fileCreated(path: string) {
		return this.fileChanged(path);
	}

	fileDeleted(path: string) {
		return this.onEvent(async () => {
			if (this.quiet.has(path)) return;
			const id = this.byPath.get(path);
			if (!id) return;
			const n = this.notes.get(id)!;
			if (this.remote.readOnly || n.text !== n.base) {
				// text changed elsewhere since the last agreement: bring the file back instead of deleting it for everyone
				await n.onDisk(null);
				return;
			}
			try {
				await this.remote.deleteFile(path);
			} catch (e) {
				this.hooks.log?.("delete: server not reachable, will retry", String(e)); // the file is still gone here; the next index sync tells the server
			}
		});
	}

	fileRenamed(from: string, to: string) {
		return this.onEvent(async () => {
			if (this.quiet.has(to)) return;
			const id = this.byPath.get(from);
			if (!id || this.remote.readOnly) return;
			this.byPath.delete(from);
			this.byPath.set(to, id);
			this.notes.get(id)!.moved(to);
			await this.sendMove(id, from, to);
		});
	}

	/** Make sure a note's pending outside edit is merged (used right before the editor binds to it). */
	ready(path: string) {
		return this.onEvent(async () => {
			const id = this.byPath.get(path);
			if (id) await this.notes.get(id)!.reconcile(path);
		});
	}

	note(path: string) {
		const id = this.byPath.get(path);
		return id ? this.notes.get(id) : undefined;
	}

	get size() {
		return this.notes.size;
	}

	// ---------------------------------------------------------------- remembering

	private saveSoon() {
		if (this.saveTimer || this.stopped) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			this.saveNow();
		}, 300);
	}

	private saveNow() {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = null;
		const out: Record<string, NoteRecord> = {};
		for (const [id, n] of this.notes) {
			const r = n.record();
			if (r) out[id] = r;
		}
		this.records = out;
		this.state.save(out);
	}
}
