import type { SignInState } from "../live/signin.ts";
import { methodName } from "../live/signin.ts";
import type { ProviderInfo, VaultInfo } from "../live/gateway.ts";

/**
 * The one answer to "am I signed in, am I connected, how far along is the sync". Everything that draws
 * (the status bar, the settings tab) reads it; only the connector writes it, through `next`.
 */
export type Who = { user: string; via: string };
export type Phase = "checking" | "index" | "notes";
export type Conn =
	| { kind: "setup" } // no server, or never signed in
	| ({ kind: "signed_out" } & Who) // the server said 401
	| ({ kind: "idle" } & Who) // signed in, not wanting live
	| ({ kind: "offline"; retryAt: number; reason: string } & Who)
	| ({ kind: "connecting"; phase: Phase; done: number; total: number } & Who)
	| ({ kind: "live"; readOnly: boolean; notes: number; attaching?: { done: number; total: number }; socket: "up" | "reconnecting" } & Who)
	| ({ kind: "stopped"; reason: string } & Who); // refused, live sync off, non-empty folder

export type Vaults = VaultInfo[] | "loading" | { error: string };
/** The ways in the server offers (the sign-in form draws them); `null` until asked. */
export type Providers = ProviderInfo[] | "loading" | null;
export type State = { conn: Conn; want: boolean; vault: string; vaults: Vaults; providers: Providers };

export type Event =
	| { t: "signin"; result: SignInState }
	| { t: "signedOut" }
	| { t: "want"; on: boolean }
	| { t: "phase"; phase: Phase }
	| { t: "progress"; done: number; total: number }
	| { t: "live"; readOnly: boolean; notes: number }
	| { t: "socket"; up: boolean }
	| { t: "attachFailed" }
	| { t: "unreachable"; reason: string; retryAt: number }
	| { t: "refused"; reason: string }
	| { t: "vaults"; list: Vaults }
	| { t: "providers"; list: Providers }
	| { t: "vault"; name: string };

export const initial = (): State => ({ conn: { kind: "setup" }, want: false, vault: "", vaults: "loading", providers: null });

const NOBODY: Who = { user: "", via: "" };
const whoOf = (c: Conn): Who => (c.kind === "setup" ? NOBODY : { user: c.user, via: c.via });
const signedIn = (c: Conn) => c.kind !== "setup" && c.kind !== "signed_out";

/** The state after an event. Pure: no clock, no network. */
export function next(s: State, e: Event): State {
	const c = s.conn;
	const w = whoOf(c);
	switch (e.t) {
		case "signin": {
			const r = e.result;
			if (r.kind === "not_set_up") return { ...s, conn: { kind: "setup" } };
			if (r.kind === "ended") return { ...s, conn: { kind: "signed_out", user: r.user, via: r.via } };
			const who = { user: r.user, via: r.via };
			// a check that cannot reach the server says nothing about a connection that is moving or already offline
			if (r.kind === "unreachable") return c.kind === "connecting" || c.kind === "live" || c.kind === "offline" ? s : { ...s, conn: { kind: "offline", retryAt: 0, reason: "the server can't be reached", ...who } };
			// signed in: tell a signed-out, set-up or offline screen; leave a connection that is already moving alone
			if (c.kind === "setup" || c.kind === "signed_out" || c.kind === "offline") return { ...s, conn: { kind: "idle", ...who } };
			return { ...s, conn: { ...c, ...who } };
		}
		case "signedOut":
			return { ...s, conn: { kind: "signed_out", ...w } };
		case "want": {
			if (!e.on) {
				const conn: Conn = signedIn(c) ? { kind: "idle", ...w } : c;
				return { ...s, want: false, conn };
			}
			if (c.kind === "live") return { ...s, want: true };
			if (!signedIn(c)) return { ...s, want: true };
			return { ...s, want: true, conn: { kind: "connecting", phase: "checking", done: 0, total: 0, ...w } };
		}
		case "phase":
			return c.kind === "connecting" ? { ...s, conn: { ...c, phase: e.phase } } : s;
		case "progress": {
			if (c.kind === "connecting") {
				const done = e.total === c.total ? Math.max(c.done, e.done) : e.done;
				return { ...s, conn: { ...c, phase: "notes", done, total: e.total } };
			}
			if (c.kind === "live") {
				const done = Math.max(c.attaching && c.attaching.total === e.total ? c.attaching.done : 0, e.done);
				const attaching = done >= e.total ? undefined : { done, total: e.total };
				return { ...s, conn: { ...c, attaching } };
			}
			return s;
		}
		case "live": {
			if (c.kind === "live") return { ...s, conn: { ...c, readOnly: e.readOnly, notes: e.notes } };
			if (c.kind === "setup" || c.kind === "signed_out") return s;
			const carried = c.kind === "connecting" && c.total > 0 && c.done < c.total ? { done: c.done, total: c.total } : undefined;
			return { ...s, conn: { kind: "live", readOnly: e.readOnly, notes: e.notes, attaching: carried, socket: "up", ...w } };
		}
		case "attachFailed":
			return c.kind === "live" ? { ...s, conn: { ...c, attaching: undefined } } : s;
		case "socket":
			// the socket says nothing until the vault is live: socket up is not "connected"
			return c.kind === "live" ? { ...s, conn: { ...c, socket: e.up ? "up" : "reconnecting" } } : s;
		case "unreachable":
			return signedIn(c) ? { ...s, conn: { kind: "offline", retryAt: e.retryAt, reason: e.reason, ...w } } : s;
		case "refused":
			return signedIn(c) ? { ...s, conn: { kind: "stopped", reason: e.reason, ...w } } : s;
		case "vaults":
			return { ...s, vaults: e.list };
		case "providers":
			return { ...s, providers: e.list };
		case "vault":
			return { ...s, vault: e.name };
	}
}

export class Store {
	private state: State;
	private subs = new Set<(s: State) => void>();
	constructor(state: State = initial()) {
		this.state = state;
	}
	get(): State {
		return this.state;
	}
	/** Applies the event and tells every subscriber before it returns. */
	dispatch(e: Event) {
		this.state = next(this.state, e);
		for (const fn of [...this.subs]) fn(this.state);
	}
	subscribe(fn: (s: State) => void): () => void {
		this.subs.add(fn);
		return () => void this.subs.delete(fn);
	}
}

export type Action = "signIn" | "signInAgain" | "connect" | "disconnect" | "cancel" | "retry";
export type Copy = {
	/** The status bar text (after "agent-wiki: "). */
	bar: string;
	/** Settings: the connection row's name and explanation, and whether it is a warning. */
	title: string;
	detail: string;
	warn: boolean;
	/** The one button for this state. */
	primary?: { label: string; action: Action };
	progress?: { done: number; total: number };
};

const PHASE: Record<Phase, string> = { checking: "Checking your sign-in…", index: "Getting the list of notes…", notes: "Opening your notes…" };

/** The words for every state, in one place. The status bar and settings both come from here. */
export function describe(s: State): Copy {
	const c = s.conn;
	switch (c.kind) {
		case "setup":
			return { bar: "not set up", title: "Not signed in", detail: "Enter your server address, then sign in.", warn: false, primary: { label: "Sign in", action: "signIn" } };
		case "signed_out":
			return {
				bar: "⚠ signed out, edits kept here (click)",
				title: "Your sign-in on this device ended",
				detail: "An admin signed this device out, or your token was changed. Your edits stay on this device and sync again after you sign in.",
				warn: true,
				primary: { label: c.via === "token" || !c.via ? "Sign in again" : `Sign in again with ${methodName(c.via)}`, action: "signInAgain" },
			};
		case "idle":
			return { bar: "signed in", title: "Not connected", detail: `Signed in as ${c.user} via ${methodName(c.via)}. Press Connect to keep this vault live.`, warn: false, primary: { label: "Connect", action: "connect" } };
		case "offline":
			return { bar: "offline, edits kept here", title: "Offline", detail: `Signed in as ${c.user}, but the server can't be reached. Your edits are kept on this device and sync when the server is back.`, warn: false, primary: { label: "Try now", action: "retry" } };
		case "connecting": {
			const known = c.total > 0;
			return {
				bar: known ? `connecting · ${c.done} of ${c.total} notes` : "connecting…",
				title: "Connecting…",
				detail: known ? `${PHASE[c.phase]} ${c.done} of ${c.total} notes.` : PHASE[c.phase],
				warn: false,
				primary: { label: "Cancel", action: "cancel" },
				progress: known ? { done: c.done, total: c.total } : undefined,
			};
		}
		case "live": {
			const ro = c.readOnly ? " (read only)" : "";
			if (c.socket === "reconnecting") return { bar: "reconnecting…", title: "Reconnecting…", detail: "The connection dropped. Your edits are kept here and sync when it is back.", warn: false, primary: { label: "Disconnect", action: "disconnect" } };
			const a = c.attaching;
			return {
				bar: a ? `connected · syncing ${a.done} of ${a.total}${ro}` : `connected · ${c.notes} notes${ro}`,
				title: "Connected",
				detail: a ? `You can edit now. Still opening notes: ${a.done} of ${a.total}.` : `${c.notes} notes are live${c.readOnly ? ", read only" : ""}.`,
				warn: false,
				primary: { label: "Disconnect", action: "disconnect" },
				progress: a,
			};
		}
		case "stopped":
			return { bar: `stopped: ${c.reason}`, title: "Stopped", detail: c.reason, warn: false, primary: { label: "Connect", action: "connect" } };
	}
}
