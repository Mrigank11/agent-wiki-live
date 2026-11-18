import { GatewayError, type ProviderInfo, type VaultInfo, type Who as GatewayWho } from "../live/gateway.ts";
import { probe } from "../live/signin.ts";
import type { SessionHolder } from "../engine/LiveSession.ts";
import type { Phase, Store } from "./connection.ts";

/** Seconds to wait before each retry of an unreachable server: 2, 5, 15, 30, then every 60. */
export const RETRY_SECONDS = [2, 5, 15, 30, 60];

/** The server will not take this connection (no access, a folder that is not empty): retrying cannot help. */
export class Refusal extends Error {
	constructor(message: string) {
		super(message);
		this.name = "Refusal";
	}
}

/** What opening a session reports as it goes. Reports from a connect that has since been cancelled are dropped. */
export type OpenHooks = {
	phase(p: Phase): void;
	progress(done: number, total: number): void;
	/** The vault is usable (its file index has arrived); notes may still be attaching. */
	live(readOnly: boolean, notes: number): void;
	socket(up: boolean): void;
	refused(reason: string): void;
	/** The background attach of notes ended early; the vault is live but not every note is open. */
	attachFailed(reason: string): void;
	/** Aborted when this connect is cancelled, refused or superseded: an open that is waiting on the network must give up at once. */
	signal: AbortSignal;
};

export type Clock = {
	now(): number;
	setTimeout(fn: () => void, ms: number): unknown;
	clearTimeout(h: unknown): void;
};

export type ConnectorDeps = {
	holder: SessionHolder<{ stop(): void }>;
	gateway(): { whoami(): Promise<GatewayWho>; vaults(): Promise<VaultInfo[]>; providers(): Promise<{ providers: ProviderInfo[] }> };
	/** The name and way of sign-in saved on this device. */
	saved(): { user: string; via: string };
	/** Remember the wish to be connected, so it survives anything. */
	save(want: boolean): Promise<void>;
	/** Open the live session: the socket, the file index, the engine. Throws `Refusal` for a "no", anything else is a network trouble. */
	open(hooks: OpenHooks): Promise<{ stop(): void }>;
	/** Called when the app comes back to the front or the network returns while connected, to wake a sleeping socket. */
	poke?(): void;
	clock?: Clock;
};

const REAL_CLOCK: Clock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) };

class Cancelled extends Error {}
class Stop extends Error {}

/**
 * The one runner of side effects: connects, retries an unreachable server, and reacts to the app coming to the
 * front. It writes everything it learns into the store; nothing else does. The person's wish ("keep this vault
 * live") is saved when they press Connect and pursued until they disconnect or the server ends the sign-in.
 */
export class Connector {
	private store: Store;
	private d: ConnectorDeps;
	private clock: Clock;
	/** Bumped at every connect and cancel: reports from an older one are ignored. */
	private gen = 0;
	private attempts = 0;
	private timer: unknown = null;
	private flight: Promise<void> | null = null;
	/** The Connect press that is being served, from the moment it is made (before it has saved) until it settles. A second press joins it. */
	private pending: Promise<void> | null = null;
	/** What the running attempt's open is told to give up with, and the attempt (gen) the server refused, if it did. */
	private ctl: AbortController | null = null;
	private refusedGen = -1;
	/** Wishes are applied one after the other, so a Cancel then Connect cannot cross. */
	private ops: Promise<unknown> = Promise.resolve();
	private disposed = false;

	constructor(store: Store, deps: ConnectorDeps) {
		this.store = store;
		this.d = deps;
		this.clock = deps.clock ?? REAL_CLOCK;
	}

	/** The person asks to be connected, or not. Resolves when it is done (connected, or given up for now). */
	want(on: boolean): Promise<void> {
		if (on) return this.connect(true);
		this.gen++;
		this.pending = null; // the wish is withdrawn: a later Connect is a new one, not a join
		this.abortOpen(); // an open that is already waiting on the network gives up now, so Cancel does not wait for it
		this.cancelRetry();
		this.store.dispatch({ t: "want", on: false });
		const run = this.ops.then(async () => {
			await this.d.holder.disconnect();
			await this.d.save(false);
		});
		this.ops = run.catch(() => {});
		return run;
	}

	/** Connect now. `save`: the person just asked (the wish is saved first); otherwise the wish is already saved and is only being pursued. */
	private connect(save: boolean, force = false): Promise<void> {
		const s = this.store.get();
		if (s.want && this.pending) return this.pending; // a second Connect joins the one in progress, even before it has saved
		if (s.conn.kind === "live" && s.want) {
			if (!force) return Promise.resolve();
			this.store.dispatch({ t: "want", on: false }); // start over: Connecting, with progress from 0
		}
		this.cancelRetry();
		this.store.dispatch({ t: "want", on: true }); // the screen answers at once
		const run: Promise<void> = this.ops.then(async () => {
			try {
				if (this.disposed) return;
				if (save) await this.d.save(true); // saved before anything else: killed mid-connect, the wish is not lost
				if (this.store.get().want) await this.attempt();
			} finally {
				if (this.pending === run) this.pending = null; // settled: the next press starts afresh
			}
		});
		this.pending = run;
		this.ops = run.catch(() => {});
		return run;
	}

	/** The "Reconnect" command: a fresh session even when one is live. */
	reconnect(): Promise<void> {
		if (!this.store.get().want) return this.want(true);
		return this.connect(false, true);
	}

	/** Ask the server whether this device is signed in, and show the answer. */
	async checkSignIn() {
		const r = await probe(() => this.d.gateway().whoami(), this.d.saved());
		this.store.dispatch({ t: "signin", result: r });
		return r;
	}

	/** Ask the server for the vaults this person may open; the answer (or the trouble) goes into the store. */
	async loadVaults() {
		this.store.dispatch({ t: "vaults", list: "loading" });
		try {
			this.store.dispatch({ t: "vaults", list: await this.d.gateway().vaults() });
		} catch (e) {
			this.store.dispatch({ t: "vaults", list: { error: (e as Error).message } });
		}
	}

	/** Ask the server which ways of signing in it offers. */
	async loadProviders() {
		this.store.dispatch({ t: "providers", list: "loading" });
		try {
			this.store.dispatch({ t: "providers", list: (await this.d.gateway().providers()).providers });
		} catch {
			this.store.dispatch({ t: "providers", list: null });
		}
	}

	/** The person has just signed in. A wish kept from before (edits kept while signed out) connects now. */
	signedIn(who: { name: string; via?: string }) {
		this.store.dispatch({ t: "signin", result: { kind: "signed_in", user: who.name, via: who.via ?? this.d.saved().via } });
		if (this.store.get().want) void this.connect(false);
	}

	/** The server said 401. Not signed in again by itself: that would undo a revoke. */
	signedOut() {
		this.gen++;
		this.abortOpen();
		this.cancelRetry();
		this.store.dispatch({ t: "signedOut" });
		void this.d.holder.disconnect();
	}

	/** "Try now": the waits start over. */
	retryNow() {
		this.attempts = 0;
		if (this.store.get().conn.kind !== "offline") return;
		if (this.store.get().want) void this.connect(false);
		else void this.checkSignIn(); // not asked to be connected: only look again
	}

	lifecycle(ev: "foreground" | "online" | "layout-ready") {
		if (this.disposed) return;
		const s = this.store.get();
		if (s.conn.kind === "signed_out") return; // waits for the person
		if (ev === "layout-ready") {
			this.attempts = 0;
			if (s.want && s.vault) void this.connect(false);
			else void this.checkSignIn();
			return;
		}
		if (s.conn.kind === "offline") return this.retryNow();
		if (s.conn.kind === "live") this.d.poke?.();
	}

	dispose() {
		this.disposed = true;
		this.gen++;
		this.abortOpen();
		this.cancelRetry();
		void this.d.holder.disconnect();
	}

	// ------------------------------------------------------------------ one try

	private attempt(): Promise<void> {
		if (this.flight) return this.flight;
		const gen = ++this.gen;
		const ctl = (this.ctl = new AbortController());
		const run = this.tryOnce(gen, ctl.signal).finally(() => {
			if (this.ctl === ctl) this.ctl = null;
			if (this.flight === run) this.flight = null;
		});
		this.flight = run;
		return run;
	}

	private abortOpen() {
		this.ctl?.abort();
		this.ctl = null;
	}

	private hooks(gen: number, signal: AbortSignal): OpenHooks {
		const live = (fn: () => void) => () => gen === this.gen && fn();
		return {
			phase: (p) => live(() => this.store.dispatch({ t: "phase", phase: p }))(),
			progress: (done, total) => live(() => this.store.dispatch({ t: "progress", done, total }))(),
			live: (readOnly, notes) => live(() => { this.attempts = 0; this.store.dispatch({ t: "live", readOnly, notes }); })(),
			socket: (up) => live(() => this.store.dispatch({ t: "socket", up }))(),
			// the server said no: that is the answer. The open may still be waiting for an index that will never come; end it, and
			// whatever it then reports (a timeout) is not a network drop
			refused: (reason) => live(() => { this.refusedGen = gen; this.store.dispatch({ t: "refused", reason }); this.abortOpen(); })(),
			attachFailed: () => live(() => this.store.dispatch({ t: "attachFailed" }))(),
			signal,
		};
	}

	private async tryOnce(gen: number, signal: AbortSignal) {
		try {
			await this.d.holder.connect(async () => {
				if (gen !== this.gen) throw new Cancelled();
				this.store.dispatch({ t: "phase", phase: "checking" });
				const r = await probe(() => this.d.gateway().whoami(), this.d.saved());
				if (gen !== this.gen) throw new Cancelled();
				if (r.kind === "unreachable") throw new Error("the server can't be reached");
				this.store.dispatch({ t: "signin", result: r });
				if (r.kind !== "signed_in") throw new Stop(); // not set up, or the server says signed out: waits for the person
				return this.d.open(this.hooks(gen, signal));
			});
		} catch (e) {
			this.failed(e, gen);
		}
	}

	private failed(e: unknown, gen: number) {
		if (gen !== this.gen || gen === this.refusedGen || e instanceof Cancelled || e instanceof Stop) return;
		if (e instanceof GatewayError && e.status === 401) return this.signedOut();
		if (e instanceof Refusal || (e as Error)?.name === "NonEmptyFolderError" || (e instanceof GatewayError && e.status < 500)) {
			return void this.store.dispatch({ t: "refused", reason: (e as Error).message });
		}
		// the network, or a server that is down: keep what is on this device and try again
		const wait = RETRY_SECONDS[Math.min(this.attempts, RETRY_SECONDS.length - 1)] * 1000;
		this.attempts++;
		const retryAt = this.clock.now() + wait;
		this.store.dispatch({ t: "unreachable", reason: (e as Error)?.message ?? "the server can't be reached", retryAt });
		this.cancelRetry();
		this.timer = this.clock.setTimeout(() => {
			this.timer = null;
			if (this.store.get().want && this.store.get().conn.kind === "offline") void this.connect(false);
		}, wait);
	}

	private cancelRetry() {
		if (this.timer !== null) this.clock.clearTimeout(this.timer);
		this.timer = null;
	}
}
