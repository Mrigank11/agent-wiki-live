import type { NoteRecord, StatePort } from "../engine/types.ts";

/** The few file operations the note memory needs; the plugin backs them with Obsidian's vault adapter, the tests with memory. */
export interface FileStore {
	read(path: string): Promise<string | null>;
	write(path: string, text: string): Promise<void>;
	/** Replace `to` with `from`. */
	rename(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

type Records = Record<string, NoteRecord>;

/**
 * What the plugin remembers about each note of one vault (where it is, the last text known equal on disk
 * and live), in a file of its own: the settings file stays small and a cut-off write cannot take the
 * sign-in with it. One write at a time; a save while one is running replaces the queued one. A write goes
 * to `<file>.tmp` and is then renamed over the file, so the old copy stays whole until the new one is complete.
 */
export class NoteFile implements StatePort {
	private fs: FileStore;
	private path: string;
	private records: Records;
	private dirty: Records | null = null;
	private running: Promise<void> | null = null;
	private failed: unknown = null;
	private existed: boolean;

	private constructor(fs: FileStore, path: string, records: Records, existed: boolean) {
		this.fs = fs;
		this.path = path;
		this.records = records;
		this.existed = existed;
	}

	static pathFor(dir: string, vault: string) {
		return `${dir}/notes-${encodeURIComponent(vault)}.json`;
	}

	/** Reads this vault's file (never another vault's). Synchronous `load()` afterwards. */
	static async open(fs: FileStore, dir: string, vault: string): Promise<NoteFile> {
		const path = NoteFile.pathFor(dir, vault);
		const parse = (t: string | null): Records | null => {
			if (t === null) return null;
			try {
				const v = JSON.parse(t);
				return v && typeof v === "object" && !Array.isArray(v) ? (v as Records) : null;
			} catch {
				return null;
			}
		};
		// the file itself, or, when the last write was cut off between removing the old file and renaming the new one, that new one
		const found = parse(await fs.read(path)) ?? parse(await fs.read(path + ".tmp"));
		return new NoteFile(fs, path, found ?? {}, found !== null);
	}

	load(): Records {
		return structuredClone(this.records);
	}

	/** The file is there (even when empty): this device has been connected to this vault. */
	started(): boolean {
		return this.existed;
	}

	save(n: Records): void {
		this.existed = true;
		this.records = structuredClone(n);
		this.dirty = this.records;
		this.running ??= this.drain();
	}

	private async drain(): Promise<void> {
		try {
			while (this.dirty) {
				const out = this.dirty;
				this.dirty = null;
				try {
					await this.fs.write(this.path + ".tmp", JSON.stringify(out));
					await this.fs.rename(this.path + ".tmp", this.path);
					this.failed = null;
				} catch (e) {
					this.failed = e; // the previous file is untouched; the next save tries again
				}
			}
		} finally {
			this.running = null;
		}
	}

	/** Resolves when every save so far is on disk. Rejects when the last write failed. */
	async flush(): Promise<void> {
		while (this.running) await this.running;
		if (this.failed) throw this.failed;
	}
}

/** The saved settings of 0.3 and later: no notes in them. */
export type Data = { url: string; token: string; session: string; user: string; via: string; vault: string; want: boolean };
export const EMPTY: Data = { url: "", token: "", session: "", user: "", via: "", vault: "", want: false };

/**
 * Settings saved by 0.2.x carried the note memory (`notes`, `notesVault`) and `connected` inside them.
 * Moves the notes to their own file once, keeps the wish to be connected (`connected` becomes `want`) and
 * backs the old file up. Returns the new settings; the caller saves them. Settings with nothing to move come back as they are.
 */
export async function migrateLegacy(raw: Record<string, unknown>, fs: FileStore, dir: string): Promise<Data> {
	const legacy = "notes" in raw || "notesVault" in raw || "connected" in raw;
	const { notes, notesVault, connected, ...rest } = raw as { notes?: Records; notesVault?: string; connected?: boolean } & Record<string, unknown>;
	const data = { ...EMPTY, ...rest, want: typeof rest.want === "boolean" ? rest.want : !!connected } as Data;
	if (!legacy) return data;
	const bak = `${dir}/data.json.bak-0.2`;
	if ((await fs.read(bak)) === null) await fs.write(bak, JSON.stringify(raw));
	if (notes && Object.keys(notes).length) {
		// notes saved before they were named for a vault belong to the vault the plugin was set to
		const owner = notesVault || data.vault;
		if (owner) {
			const f = await NoteFile.open(fs, dir, owner);
			if (Object.keys(f.load()).length === 0) {
				f.save(notes);
				await f.flush();
			}
		}
	}
	return data;
}
