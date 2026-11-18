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
