import type { VaultSync } from "./VaultSync.ts";
import type { HocuspocusRemote } from "../live/remote.ts";

/** What the engine hears from the vault (Obsidian's file events, or a test's). */
export interface FileEvents {
	changed(path: string): unknown;
	deleted(path: string): unknown;
	renamed(from: string, to: string): unknown;
}
/** Somewhere to listen for them; the returned function stops listening. */
export interface VaultEvents {
	subscribe(h: FileEvents): () => void;
}

/**
 * One live connection and everything that hangs off it: the socket, the engine and every listener,
 * timer or editor binding made for it. They are created together and stopped together, so a
 * connection that has ended can never act on the vault again.
 */
export class LiveSession {
	private owned: (() => void)[] = [];
	private stopped = false;

	readonly remote: HocuspocusRemote;
	readonly vs: VaultSync;
	constructor(remote: HocuspocusRemote, vs: VaultSync) {
		this.remote = remote;
		this.vs = vs;
	}

	/** Something to undo when the session stops (a listener, a timer, an editor binding). */
	own(undo: () => void) {
		if (this.stopped) undo();
		else this.owned.push(undo);
	}

	/** Feed the vault's file events to the engine for as long as the session lives. */
	watch(events: VaultEvents) {
		this.own(events.subscribe({
			changed: (p) => this.vs.fileChanged(p),
			deleted: (p) => this.vs.fileDeleted(p),
			renamed: (a, b) => this.vs.fileRenamed(a, b),
		}));
	}

	stop() {
		if (this.stopped) return;
		this.stopped = true;
		for (const undo of this.owned.splice(0).reverse()) {
			try {
				undo();
			} catch {
				/* one failing undo must not leave the rest running */
			}
		}
		this.vs.stop();
		this.remote.destroy();
	}
}

/** Holds the one current session. Connect is single-flight; a disconnect during a connect wins. */
export class SessionHolder<S extends { stop(): void } = LiveSession> {
	current: S | null = null;
	private flight: Promise<void> | null = null;
	private generation = 0;

	/** Open a session with `open`, replacing the current one. A call made while one is opening joins it. */
	connect(open: () => Promise<S>): Promise<void> {
		if (this.flight) return this.flight;
		const gen = this.generation;
		const run = (async () => {
			this.current?.stop();
			this.current = null;
			const s = await open();
			if (gen !== this.generation) return void s.stop(); // disconnected while opening
			this.current = s;
		})();
		const flight = run.finally(() => {
			if (this.flight === flight) this.flight = null;
		});
		this.flight = flight;
		return flight;
	}

	async disconnect() {
		this.generation++;
		const f = this.flight;
		this.current?.stop();
		this.current = null;
		if (f) await f.catch(() => {});
	}
}
