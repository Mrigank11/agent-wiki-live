import { GatewayError, type Who } from "./gateway.ts";

/** What the plugin knows about its sign-in, from asking the server (never from a name saved on disk). */
export type SignInState =
	| { kind: "not_set_up" }
	| { kind: "signed_in"; user: string; via: string }
	| { kind: "ended"; user: string; via: string }
	| { kind: "unreachable"; user: string; via: string };

/** Ask the server whether this device is still signed in. Only a 401 means "signed out": a network error or a 5xx says nothing about the sign-in. */
export async function probe(whoami: () => Promise<Who>, saved: { user: string; via: string }): Promise<SignInState> {
	if (!saved.user) return { kind: "not_set_up" };
	try {
		const who = await whoami();
		return { kind: "signed_in", user: who.name, via: who.via || saved.via };
	} catch (e) {
		if (e instanceof GatewayError && e.status === 401) return { kind: "ended", user: saved.user, via: saved.via };
		return { kind: "unreachable", user: saved.user, via: saved.via };
	}
}

const METHOD: Record<string, string> = { token: "your token", tailscale: "Tailscale", github: "GitHub" };
export const methodName = (via: string) => METHOD[via] ?? (via ? via : "your token");

export type Copy = {
	/** The status bar text (after "agent-wiki: "). */
	bar: string;
	/** Settings: the row's name, its explanation, and whether it is a warning. */
	title: string;
	detail: string;
	warn: boolean;
	/** The one thing to do about it, when there is one. */
	action?: string;
};

/** The words for each state, in one place. */
export function describe(s: SignInState, synced?: string): Copy {
	switch (s.kind) {
		case "not_set_up":
			return { bar: "not set up", title: "Not signed in", detail: "Enter your server address, then sign in.", warn: false };
		case "signed_in":
			return { bar: synced ?? "signed in", title: `Signed in as ${s.user} via ${methodName(s.via)} · this device`, detail: "This device stays signed in until you sign it out here or an admin does.", warn: false };
		case "ended":
			return {
				bar: "⚠ signed out, edits kept here (click)",
				title: "Your sign-in on this device ended",
				detail: "An admin signed this device out, or your token was changed. Your edits stay on this device and sync again after you sign in.",
				warn: true,
				action: s.via === "token" || !s.via ? "Sign in again" : `Sign in again with ${methodName(s.via)}`,
			};
		case "unreachable":
			return { bar: "offline, edits kept here", title: `Signed in as ${s.user}, but the server can't be reached`, detail: "Your edits are kept on this device and sync when the server is back.", warn: false, action: "Try again" };
	}
}
