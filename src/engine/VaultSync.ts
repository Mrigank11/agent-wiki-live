import type * as Y from "yjs";
import { NoteSync } from "./NoteSync.ts";
import type { DiskPort, Hooks, IndexEntry, NoteRecord, RemotePort, StatePort } from "./types.ts";

export type VaultSyncOptions = {
	settleMs?: number;
	isOpen?: (path: string) => boolean;
	/**
	 * Day 1 connects only an empty folder. Merging a folder that already holds notes (adopt identical
	 * files, upload new ones, keep differing ones as local copies) is built and tested but switched off
	 * until it has had more use; the plugin never sets this.
	 */
	adoptExisting?: boolean;
};

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
	/** Paths we are creating or moving ourselves, so the file event they raise is not taken as a person's edit. */
	private quiet = new Set<string>();

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

	private enqueue(fn: () => Promise<void>) {
		this.queue = this.queue.then(fn).catch((e) => this.hooks.log?.("engine error", String(e?.stack ?? e)));
		return this.queue;
	}

	/** Resolves when every queued step has run (for tests and for "idle" in the status bar). */
	idle() {
		return this.queue;
	}

	async start() {
		if (!this.opts.adoptExisting && Object.keys(this.records).length === 0 && (await this.disk.list()).length > 0) throw new NonEmptyFolderError();
		await this.enqueue(async () => {
			await this.syncIndex(true);
		});
		this.remote.index.observe(this.onIndex as any);
	}

	stop() {
		this.stopped = true;
		this.remote.index.unobserve(this.onIndex as any);
		this.saveNow(); // before the notes go: what we remember is what they know
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
		const entries = this.entries();
		const localPaths = new Set(await this.disk.list());
		const claimed = new Set<string>();

		for (const [id, e] of entries) {
			if (e.deleted) {
				await this.remoteDeleted(id);
				continue;
			}
			claimed.add(e.path);
			const known = this.notes.get(id);
			if (known) {
				if (known.path !== e.path) await this.remoteMoved(id, known, e.path);
				continue;
			}
			await this.attach(id, e.path, localPaths);
		}

		// files on disk the server does not know
		for (const p of localPaths) {
			if (claimed.has(p) || this.quiet.has(p)) continue;
			const was = Object.entries(this.records).find(([, r]) => r.path === p);
			if (was && !entries.has(was[0])) {
				// we knew it and the server forgot it entirely: treat as a new file
				delete this.records[was[0]];
			}
			if (this.remote.readOnly) continue;
			const text = await this.disk.read(p);
			if (text === null) continue;
			await this.remote.createFile(p, text); // the index observer attaches it
		}

		// notes we knew that are gone from the index and from disk
		for (const id of Object.keys(this.records)) {
			if (!entries.has(id) && !this.notes.has(id)) delete this.records[id];
		}
		this.saveSoon();
	}

	private async attach(id: string, path: string, localPaths: Set<string>) {
		const live = this.remote.openNote(id);
		await live.synced;
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
			await this.remote.createFile(path, disk);
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

	private async keepLocalCopy(path: string, text: string) {
		if (this.remote.readOnly) return;
		const stem = path.replace(/\.md$/, "");
		const taken = new Set(await this.disk.list());
		let name = `${stem} (local copy).md`;
		for (let i = 2; taken.has(name); i++) name = `${stem} (local copy ${i}).md`;
		this.quiet.add(name);
		await this.disk.write(name, text);
		this.quiet.delete(name);
		await this.remote.createFile(name, text);
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
				if (disk !== null && !this.remote.readOnly) await this.remote.createFile(path, disk);
				return;
			}
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
			await this.remote.deleteFile(path);
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
			await this.remote.moveFile(from, to);
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
