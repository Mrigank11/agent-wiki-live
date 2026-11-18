import type * as Y from "yjs";

/** The files of the vault, as the engine sees them. The Obsidian adapter and the tests both implement it. */
export interface DiskPort {
	/** The note's text, or null when there is no such file. */
	read(path: string): Promise<string | null>;
	/** Create or replace a note's file (parent folders are created). */
	write(path: string, text: string): Promise<void>;
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	/** Every markdown note's path. */
	list(): Promise<string[]>;
}

export type IndexEntry = { path: string; deleted?: number };

/** One live note: its Y.Text and a way to know it has caught up with the server. */
export interface LiveNote {
	doc: Y.Doc;
	text: Y.Text;
	/** Resolves once the server's copy has been merged into `doc`. */
	synced: Promise<void>;
	/** Presence (cursors and names) for the editor binding; absent in tests that need none. */
	awareness?: import("y-protocols/awareness").Awareness | null;
	/** How many of our own changes the server has not acknowledged yet. */
	unsynced?(): number;
	destroy(): void;
}

/** The sync server, as the engine sees it. */
export interface RemotePort {
	/** The vault's file index (note id -> path). Already synced when the engine starts. */
	index: Y.Map<IndexEntry>;
	/** The server's fingerprint of each note's text (note id -> fingerprint), published beside the index. Absent when the server does not publish them: every note is then opened. */
	revs?: Y.Map<string>;
	openNote(id: string): LiveNote;
	/** Create a note on the server; a name clash gets the next free name and `clash: true`. */
	createFile(path: string, text: string): Promise<{ path: string; clash?: boolean }>;
	moveFile(from: string, to: string): Promise<void>;
	deleteFile(path: string): Promise<void>;
	/** True when this person may not edit (read-only trust). */
	readOnly: boolean;
	/** Called every time the connection is back and the index has caught up (not the first time). Returns a way to stop listening. */
	onResync?(cb: () => void): () => void;
}

/** What the plugin remembers between runs, per note: where it is and the last text known equal on disk and live. */
export type NoteRecord = { path: string; base: string };
export interface StatePort {
	load(): Record<string, NoteRecord>;
	save(notes: Record<string, NoteRecord>): void;
	/** True when this device has been connected to this vault before, even if it remembers no notes (it was stopped while filling an empty folder). */
	started?(): boolean;
	/** Resolves when everything saved so far is durable. */
	flush?(): Promise<void>;
}

export type Notice = { kind: "local-copy" | "restored" | "info" | "error"; message: string };
export interface Hooks {
	notify(n: Notice): void;
	log?(msg: string, data?: unknown): void;
	/** How many of the notes being opened are attached so far (`done` of `total`). Called as the engine works through them. */
	progress?(done: number, total: number): void;
	/** The background attach ended early (a note could not be opened). The vault stays usable; the rest of its notes are not attached yet. */
	attachFailed?(reason: string): void;
}

export const ORIGIN_DISK = "agent-wiki-live:disk";
