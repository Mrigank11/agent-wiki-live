import { HocuspocusProvider, HocuspocusProviderWebsocket } from "@hocuspocus/provider";
import * as Y from "yjs";
import type { IndexEntry, LiveNote, RemotePort } from "../engine/types.ts";

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
/** A fresh note id: 12 characters of base32, the shape the sync server accepts. */
export function newNoteId(): string {
	const b = crypto.getRandomValues(new Uint8Array(12));
	return Array.from(b, (x) => B32[x & 31]).join("");
}

/** File-tree changes go through the gateway (the only writer of disk and git), which asks the sync server. */
export interface FileOps {
	/** `id` is chosen by the caller, so a repeat of the same create (a retry, a double event) is the same note. */
	create(path: string, text: string, id: string): Promise<{ path: string; clash?: boolean }>;
	move(from: string, to: string): Promise<void>;
	remove(path: string): Promise<void>;
}

export type RemoteOptions = {
	/** `ws://host/sync/` (the gateway proxies the sync socket). */
	url: string;
	vault: string;
	user: string;
	/** A fresh ticket whenever the provider needs one (the caller caches it until it nears its end). */
	token: () => Promise<string>;
	fileOps: FileOps;
	readOnly: boolean;
	WebSocketPolyfill?: unknown;
	/** Called when the server says live sync is off, or refuses us. */
	onRefused?: (reason: string) => void;
	onStatus?: (s: "connecting" | "connected" | "disconnected") => void;
};

const colors = ["#e11d48", "#2563eb", "#059669", "#d97706", "#7c3aed", "#0891b2", "#be185d", "#4d7c0f"];
export function colorFor(name: string) {
	let h = 0;
	for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
	return colors[h % colors.length];
}

/** One socket per vault; the file index and every note ride on it (the same shape the web editor uses). */
export class HocuspocusRemote implements RemotePort {
	readonly index: Y.Map<IndexEntry>;
	readOnly: boolean;
	private socket: HocuspocusProviderWebsocket;
	private indexProvider: HocuspocusProvider;
	private o: RemoteOptions;
	private open = new Map<string, HocuspocusProvider>();
	private syncedOf = new WeakMap<HocuspocusProvider, Promise<void>>();
	private resyncs = new Set<() => void>();
	private firstSync = true;

	constructor(o: RemoteOptions) {
		this.o = o;
		this.readOnly = o.readOnly;
		this.socket = new HocuspocusProviderWebsocket({
			url: o.url,
			...(o.WebSocketPolyfill ? { WebSocketPolyfill: o.WebSocketPolyfill } : {}),
		} as any);
		this.socket.on("status", ({ status }: { status: string }) => o.onStatus?.(status as any));
		const doc = new Y.Doc();
		this.index = doc.getMap("files");
		this.indexProvider = this.provider(`${o.vault}/__index`, doc, true);
		this.indexProvider.on("synced", () => {
			if (this.firstSync) return void (this.firstSync = false);
			for (const cb of [...this.resyncs]) cb();
		});
	}

	onResync(cb: () => void) {
		this.resyncs.add(cb);
		return () => void this.resyncs.delete(cb);
	}

	private provider(name: string, doc: Y.Doc, isIndex = false) {
		let done!: () => void;
		const synced = new Promise<void>((ok) => (done = ok));
		const p = new HocuspocusProvider({
			websocketProvider: this.socket,
			name,
			document: doc,
			token: () => this.o.token(),
			onSynced: () => done(),
		} as any);
		this.syncedOf.set(p, synced);
		p.on("authenticationFailed", ({ reason }: { reason: string }) => this.o.onRefused?.(reason || "refused by the server"));
		if (isIndex)
			p.on("close", ({ event }: { event?: { code?: number; reason?: string } }) => {
				if (event?.code === 4403 || /live sync is off/i.test(event?.reason ?? "")) this.o.onRefused?.(event?.reason || "live sync is off for this vault");
			});
		p.attach();
		p.awareness?.setLocalStateField("user", { name: this.o.user, color: colorFor(this.o.user), colorLight: colorFor(this.o.user) + "33" });
		return p;
	}

	/** Resolves once the file index has arrived. Rejects when `signal` aborts, or when the server does not answer in time. */
	synced(timeoutMs = 20000, signal?: AbortSignal): Promise<void> {
		return new Promise((ok, bad) => {
			const done = () => {
				clearTimeout(t);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				done();
				bad(new Error("cancelled"));
			};
			const t = setTimeout(() => {
				done();
				bad(new Error("the sync server did not answer"));
			}, timeoutMs);
			if (signal?.aborted) return onAbort();
			signal?.addEventListener("abort", onAbort);
			this.syncedOf.get(this.indexProvider)!.then(() => {
				done();
				ok();
			});
		});
	}

	openNote(id: string): LiveNote {
		const doc = new Y.Doc();
		const p = this.provider(`${this.o.vault}/${id}`, doc);
		this.open.set(id, p);
		const synced = this.syncedOf.get(p)!;
		return {
			doc,
			text: doc.getText("content"),
			synced,
			awareness: p.awareness,
			unsynced: () => p.unsyncedChanges,
			destroy: () => {
				p.destroy();
				doc.destroy();
				this.open.delete(id);
			},
		} as LiveNote;
	}

	createFile(path: string, text: string) {
		return this.o.fileOps.create(path, text, newNoteId());
	}
	moveFile(from: string, to: string) {
		return this.o.fileOps.move(from, to);
	}
	deleteFile(path: string) {
		return this.o.fileOps.remove(path);
	}

	/** Drop the socket (a lost connection, a phone going to sleep). Edits keep landing in the local copy. */
	goOffline() {
		this.socket.disconnect();
	}
	goOnline() {
		// disconnect() only asks the socket to close. Until the close arrives the library still reports "connected",
		// ignores connect() and has not set shouldConnect, so a goOnline() right after goOffline() would leave us
		// offline for good. Setting it first makes the pending close reconnect on its own.
		this.socket.shouldConnect = true;
		void this.socket.connect();
	}

	destroy() {
		for (const p of this.open.values()) p.destroy();
		this.open.clear();
		this.indexProvider.destroy();
		this.socket.destroy();
	}
}
