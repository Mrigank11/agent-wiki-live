import type { FileOps } from "./remote.ts";

/** One HTTP call, as Obsidian's requestUrl (or fetch in tests) makes it. Must not throw on 4xx/5xx. */
export type Http = (req: { url: string; method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: Record<string, string>; text: string }>;

/** What the gateway's sign-in page shows: every active way in, generic over providers. */
export type ProviderInfo = { id: string; name: string; kind: "redirect" | "direct" | string; start?: string };
export type Providers = { token: boolean; tailscale?: boolean; providers: ProviderInfo[] };
export type VaultInfo = { name: string; trust: string; read_only: boolean };
export type Ticket = { ticket: string; expires: number; read_only: boolean; user: string };
export type Who = { name: string; email: string; admin: boolean; via?: string };

export class GatewayError extends Error {
	status: number;
	rule: string;
	constructor(status: number, rule: string, message: string) {
		super(message);
		this.name = "GatewayError";
		this.status = status;
		this.rule = rule;
	}
}

const CSRF = "agent-wiki-admin";
const API = "/api/app/v1";

export const base64url = (b: Uint8Array) => btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** A fresh secret for one sign-in and its challenge (the gateway keeps only the challenge until the code is traded). */
export async function newHandback() {
	const verifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
	const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
	return { verifier, challenge };
}

/** The gateway as the plugin sees it: sign in with whatever the server offers, list vaults, get tickets, change files. */
export class Gateway {
	readonly base: string;
	private http: Http;
	private cookies = new Map<string, string>();
	/** Called when the session is gone (401): the caller signs in again or asks the person to. */
	onSignedOut: () => void = () => {};

	constructor(base: string, http: Http) {
		this.base = base.replace(/\/+$/, "");
		this.http = http;
	}

	/** The session cookie, so the plugin can keep a session across restarts. */
	get session(): string {
		return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
	}
	set session(v: string) {
		this.cookies.clear();
		for (const part of v.split(/;\s*/)) {
			const i = part.indexOf("=");
			if (i > 0) this.cookies.set(part.slice(0, i), part.slice(i + 1));
		}
	}

	get wsUrl() {
		return this.base.replace(/^http/, "ws") + "/sync/";
	}

	private async call<T>(method: string, path: string, body?: unknown, quiet401 = false): Promise<T> {
		const headers: Record<string, string> = { "X-Requested-With": CSRF, Origin: new URL(this.base).origin };
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (this.cookies.size) headers.Cookie = this.session;
		const res = await this.http({ url: this.base + API + path, method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
		const raw: unknown = res.headers["set-cookie"] ?? res.headers["Set-Cookie"];
		const sc = Array.isArray(raw) ? raw.join(", ") : typeof raw === "string" ? raw : "";
		if (sc) for (const m of sc.matchAll(/(?:^|,\s*)([A-Za-z0-9_.-]+)=([^;,\s]*)/g)) if (!/^(path|expires|max-age|domain|samesite)$/i.test(m[1])) this.cookies.set(m[1], m[2]);
		if (res.status === 204) return undefined as T;
		let data: any = null;
		try {
			data = JSON.parse(res.text);
		} catch {
			/* not JSON */
		}
		if (res.status >= 400) {
			if (res.status === 401 && !quiet401) this.onSignedOut();
			const f = data?.findings?.[0];
			throw new GatewayError(res.status, f?.rule ?? "http", f?.message ?? `The server answered ${res.status}`);
		}
		return data as T;
	}

	providers() {
		return this.call<Providers>("GET", "/providers", undefined, true);
	}
	loginToken(token: string) {
		return this.call<Who>("POST", "/session", { token: token.trim() }, true);
	}
	/** A provider that proves who you are by the request itself (Tailscale). */
	loginDirect(id: string) {
		return this.call<Who>("POST", `/session/${encodeURIComponent(id)}`, {}, true);
	}
	/** The address to open in the browser for a redirect provider; the browser ends at obsidian://agent-wiki-live-signin?code=... */
	async beginRedirect(p: ProviderInfo) {
		const h = await newHandback();
		const start = p.start ?? `${API}/session/${encodeURIComponent(p.id)}/start`;
		return { url: this.base + start + (start.includes("?") ? "&" : "?") + "handback_challenge=" + h.challenge, verifier: h.verifier };
	}
	finishHandback(code: string, verifier: string) {
		return this.call<Who>("POST", "/session/handback", { code, verifier }, true);
	}
	whoami() {
		return this.call<Who>("GET", "/session", undefined, true);
	}
	async vaults() {
		return (await this.call<{ vaults: VaultInfo[] }>("GET", "/vaults")).vaults;
	}
	private cached = new Map<string, Ticket>();
	/** A ticket is good for 15 minutes; a new one is fetched when under a minute is left. */
	async ticket(vault: string): Promise<Ticket> {
		const t = this.cached.get(vault);
		if (t && t.expires - Date.now() / 1000 > 60) return t;
		const fresh = await this.call<Ticket>("GET", `/vaults/${encodeURIComponent(vault)}/ticket`);
		this.cached.set(vault, fresh);
		return fresh;
	}
	fileOps(vault: string): FileOps {
		const op = (body: unknown) => this.call<{ ok: boolean; path?: string; clash?: boolean }>("POST", `/vaults/${encodeURIComponent(vault)}/files`, body);
		return {
			create: async (path, text) => {
				const r = await op({ op: "create", path, text });
				return { path: r.path ?? path, clash: r.clash };
			},
			move: async (from, to) => void (await op({ op: "move", from, to })),
			remove: async (path) => void (await op({ op: "delete", path })),
		};
	}
	signOut() {
		return this.call<void>("DELETE", "/session", undefined, true).catch(() => {});
	}
}
