import type * as Y from "yjs";
import { fingerprint } from "./fingerprint.ts";
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
	/**
	 * Notes this device holds exactly as the server does: the text it saved is on disk and its fingerprint is the server's. They
	 * are not opened (no request, no live copy) until something changes: the server's fingerprint moves, or a file event says the
	 * file did. Then the note is opened the ordinary way, so nothing it knows is trusted beyond that comparison.
	 */
	/** Notes whose deletion this device asked of the server and whose tombstone has not reached our copy of the index yet: they are not opened again meanwhile. */
	private sentDeletes = new Set<string>();
	private dormant = new Map<string, { path: string; base: string; fp: string }>();
	private readonly onRevs: (e: Y.YMapEvent<string>) => void;
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
		this.onRevs = (e) => {
			if (this.stopped) return;
			for (const id of e.keysChanged) {
				const d = this.dormant.get(id);
				if (d && this.remote.revs?.get(id) !== d.fp) void this.onEvent(() => this.wake(id));
			}
		};
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

	/** Runs a change we make to a file ourselves with its path marked, so the file event it raises is not taken as a person's edit; the mark never outlives the change, even when it throws. */
	private async quietly(path: string, fn: () => Promise<void>) {
		this.quiet.add(path);
		try {
			await fn();
		} finally {
			this.quiet.delete(path);
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
		this.remote.revs?.observe(this.onRevs as any);
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
		this.remote.revs?.unobserve(this.onRevs as any);
		this.saveNow(); // before the notes go: what we remember is what they know
		for (const l of this.opening) l.destroy();
		this.opening.clear();
		for (const n of this.notes.values()) n.destroy();
		this.notes.clear();
		this.dormant.clear();
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

		await this.findDormant(entries, localPaths);
		const toAttach: { id: string; path: string }[] = [];
		for (const [id, e] of entries) {
			if (e.deleted) {
				this.sentDeletes.delete(id);
				await this.remoteDeleted(id);
				continue;
			}
			claimed.add(e.path);
			if (this.sentDeletes.has(id)) continue; // we deleted it; the index has not said so yet
			const sleeping = this.dormant.get(id);
			if (sleeping) {
				if (e.path === sleeping.path && localPaths.has(sleeping.path) && this.remote.revs?.get(id) === sleeping.fp) continue; // as saved, as the server has it
				this.wakeUp(id); // something moved: the ordinary attach looks at it
			}
			const known = this.notes.get(id);
			if (known) {
				if (this.unsentMoves.has(id)) {
					// renamed here while the server could not be told: tell it now instead of undoing the rename
					if (e.path !== known.path) await this.sendMove(id, e.path, known.path);
					else this.unsentMoves.delete(id); // the index already agrees with the file: nothing is owed to the server
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

		for (const id of [...this.dormant.keys()]) if (!entries.has(id)) this.wakeUp(id); // the server has forgotten it entirely: the code below decides what that means for the file
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
					await this.quietly(p, () => this.disk.remove(p));
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
			if (!entries.has(id) && !this.notes.has(id) && !this.dormant.has(id)) delete this.records[id];
		}
		this.saveSoon();
	}

	/**
	 * Which notes can stay as they are: the ones the device saved, whose file still holds exactly the saved text and whose text
	 * has the fingerprint the server publishes. The three agree, so opening the note could only find them equal.
	 */
	private async findDormant(entries: Map<string, IndexEntry>, localPaths: Set<string>) {
		const revs = this.remote.revs;
		if (!revs) return;
		const candidates: { id: string; path: string; base: string; want: string }[] = [];
		for (const [id, e] of entries) {
			const rec = this.records[id];
			const want = revs.get(id);
			if (e.deleted || !rec || want === undefined || this.notes.has(id) || this.dormant.has(id) || this.unsentMoves.has(id)) continue;
			if (rec.path !== e.path || !localPaths.has(e.path) || this.quiet.has(e.path)) continue;
			candidates.push({ id, path: e.path, base: rec.base, want });
		}
		const check = async (c: (typeof candidates)[number]) => {
			try {
				if ((await fingerprint(c.base)) !== c.want || (await this.disk.read(c.path)) !== c.base) return;
				// the answers were awaited: only a note nobody touched meanwhile may sleep
				if (this.stopped || this.notes.has(c.id) || revs.get(c.id) !== c.want) return;
				this.dormant.set(c.id, { path: c.path, base: c.base, fp: c.want });
				this.byPath.set(c.path, c.id);
			} catch (e) {
				this.hooks.log?.("could not compare a note with the server's fingerprint; it will be opened", String(e));
			}
		};
		for (let i = 0; i < candidates.length; i += 32) await Promise.all(candidates.slice(i, i + 32).map(check));
	}

	/** Stop treating a note as sleeping, so the next attach pass opens it. */
	private wakeUp(id: string) {
		const d = this.dormant.get(id);
		if (!d) return;
		this.dormant.delete(id);
		if (this.byPath.get(d.path) === id) this.byPath.delete(d.path);
	}

	/** Open a sleeping note now, the ordinary way (its file and live text are brought into agreement, whichever changed). */
	private async wake(id: string) {
		const d = this.dormant.get(id);
		if (!d || this.stopped) return;
		this.wakeUp(id);
		const e = this.remote.index.get(id);
		if (!e || e.deleted) return; // the index pass deals with a note that is gone
		try {
			await this.attachWindows([{ id, path: e.path }], new Set(await this.disk.list()), true);
		} catch (err) {
			// not opened: it is neither asleep nor open, so the next index pass (a resync, Reconnect) opens it
			for (const live of this.opening) live.destroy();
			this.opening.clear();
			this.hooks.log?.("could not open a note that changed", String(err));
		}
	}

	/** The note's live text, opening it first when it was asleep (the editor binds to it). */
	open(path: string) {
		return this.onEvent(async () => {
			const id = this.byPath.get(path);
			if (id && this.dormant.has(id)) await this.wake(id);
		}).then(() => this.note(path));
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

	private async attachWindows(items: { id: string; path: string }[], localPaths: Set<string>, quiet = false) {
		const total = items.length;
		if (!total || this.stopped) return;
		const progress = quiet ? undefined : this.hooks.progress; // opening one changed note is not "syncing" the vault
		progress?.(0, total);
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
				progress?.(++done, total);
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
			await this.quietly(path, () => this.disk.rename(rec.path, path));
			localPaths.delete(rec.path);
			localPaths.add(path);
		}
		if (rec && !localPaths.has(path)) {
			// the file is gone from disk
			if (live.text.toString() === rec.base) {
				// nobody else changed it: the deletion is the person's
				if (!this.remote.readOnly) {
					await this.remote.deleteFile(path);
					this.sentDeletes.add(id);
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
		const path = n?.path ?? this.dormant.get(id)?.path ?? rec?.path;
		this.wakeUp(id);
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
			await this.quietly(path, () => this.disk.remove(path));
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
				await this.quietly(to, () => this.disk.rename(from, to));
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
			const asleep = this.dormant.get(id);
			if (asleep) {
				if (disk === asleep.base) return; // an event for text that is what we saved: nothing changed
				return this.wake(id); // opening it brings the file's text and the server's together
			}
			await this.notes.get(id)?.onDisk(disk);
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
			if (this.dormant.has(id)) return this.wake(id); // opening it finds the file gone and does what a deletion here means
			const n = this.notes.get(id);
			if (!n) return;
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
			const asleep = this.dormant.get(id);
			if (asleep) {
				asleep.path = to;
				this.saveSoon();
			} else this.notes.get(id)?.moved(to);
			await this.sendMove(id, from, to);
		});
	}

	/** Make sure a note's pending outside edit is merged (used right before the editor binds to it). */
	ready(path: string) {
		return this.onEvent(async () => {
			const id = this.byPath.get(path);
			if (id) await this.notes.get(id)?.reconcile(path);
		});
	}

	note(path: string) {
		const id = this.byPath.get(path);
		return id ? this.notes.get(id) : undefined;
	}

	get size() {
		return this.notes.size + this.dormant.size;
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
		// attached notes report their own record; a note known but not attached yet (a save can fire mid-attach) keeps what we remembered
		const out: Record<string, NoteRecord> = { ...this.records };
		for (const [id, n] of this.notes) {
			const r = n.record();
			if (r) out[id] = r;
			else delete out[id];
		}
		for (const [id, d] of this.dormant) out[id] = { path: d.path, base: d.base };
		this.records = out;
		this.state.save(out);
	}
}
