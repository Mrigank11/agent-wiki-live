import { Component, Notice, Plugin, requestUrl, TFile } from "obsidian";
import { LiveSession, SessionHolder } from "./engine/LiveSession.ts";
import { NonEmptyFolderError, VaultSync } from "./engine/VaultSync.ts";
import { vaultState } from "./engine/vaultState.ts";
import type { NoteRecord, StatePort } from "./engine/types.ts";
import { Gateway, GatewayError, type Http, type ProviderInfo } from "./live/gateway.ts";
import { describe, probe, type SignInState } from "./live/signin.ts";
import { HocuspocusRemote } from "./live/remote.ts";
import { EditorBinder } from "./obsidian/editor.ts";
import { LiveSettingTab } from "./obsidian/settings.ts";
import { VaultDisk } from "./obsidian/vaultDisk.ts";

type Data = { url: string; token: string; session: string; user: string; via: string; vault: string; connected: boolean; notesVault: string; notes: Record<string, NoteRecord> };
const EMPTY: Data = { url: "", token: "", session: "", user: "", via: "", vault: "", connected: false, notesVault: "", notes: {} };

const http: Http = async (r) => {
	const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
	return { status: res.status, headers: res.headers, text: res.text };
};

export default class AgentWikiLive extends Plugin {
	data: Data = { ...EMPTY };
	user = "";
	connected = false;
	statusText = "";
	/** What the server last said about this device's sign-in (never inferred from the saved name). */
	signin: SignInState = { kind: "not_set_up" };
	private gw: Gateway | null = null;
	private holder = new SessionHolder();
	private status!: HTMLElement;
	private binder!: EditorBinder;
	private pending: { verifier: string } | null = null;

	async onload() {
		this.data = { ...EMPTY, ...(await this.loadData()) };
		this.user = this.data.user;
		this.status = this.addStatusBarItem();
		this.status.addClass("mod-clickable");
		this.status.onClickEvent(() => this.openSettings());
		this.binder = new EditorBinder(this.app, () => this.holder.current?.vs ?? null);
		this.registerEditorExtension(this.binder.extension);
		this.addSettingTab(new LiveSettingTab(this.app, this));
		this.registerObsidianProtocolHandler("agent-wiki-live-signin", (params) => void this.finishRedirect(params.code));
		this.addCommand({ id: "reconnect", name: "Reconnect to agent-wiki", callback: () => void this.connect() });
		this.render("not connected");
		this.app.workspace.onLayoutReady(() => {
			if (this.data.connected && this.data.vault) void this.connect();
			else void this.refreshSignIn();
		});
	}

	onunload() {
		void this.disconnect(false);
	}

	gateway() {
		if (!this.gw || this.gw.base !== this.data.url.replace(/\/+$/, "")) {
			this.gw = new Gateway(this.data.url, http);
			this.gw.device = `Obsidian · ${this.app.vault.getName()}`;
			this.gw.session = this.data.session;
			this.gw.onSignedOut = () => void this.lostSession();
		}
		return this.gw;
	}

	/** Opens this plugin's settings (the status bar's click, and the "sign in again" notice). */
	openSettings() {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	/** Ask the server whether this device is signed in, and show the truth in the status bar and settings. */
	async refreshSignIn(): Promise<SignInState> {
		if (!this.data.url) return this.setSignIn({ kind: "not_set_up" });
		return this.setSignIn(await probe(() => this.gateway().whoami(), { user: this.data.user, via: this.data.via }));
	}

	private setSignIn(s: SignInState): SignInState {
		this.signin = s;
		if (!(this.connected && s.kind === "signed_in")) this.render(describe(s).bar);
		return s;
	}

	private render(text: string) {
		this.statusText = text;
		this.status.setText(`agent-wiki: ${text}`);
	}

	// ------------------------------------------------------------------ sign-in

	private async signedIn(who: { name: string; via?: string }) {
		this.user = this.data.user = who.name;
		this.data.via = who.via ?? this.data.via;
		this.data.session = this.gateway().session;
		await this.saveData(this.data);
		this.signin = { kind: "signed_in", user: who.name, via: this.data.via };
		new Notice(`Signed in as ${who.name}.`);
		// the edits kept while signed out sync again now
		if (this.data.connected && this.data.vault && !this.connected) void this.connect();
		else if (!this.connected) this.render("signed in");
	}

	async signInToken(token: string) {
		try {
			const who = await this.gateway().loginToken(token);
			this.data.token = token.trim();
			await this.signedIn(who);
		} catch (e) {
			new Notice((e as GatewayError).message);
		}
	}

	async signInProvider(p: ProviderInfo) {
		try {
			if (p.kind === "direct") return void (await this.signedIn(await this.gateway().loginDirect(p.id)));
			const { url, verifier } = await this.gateway().beginRedirect(p);
			this.pending = { verifier };
			window.open(url);
			new Notice(`Finish signing in with ${p.name} in your browser; Obsidian will open again.`);
		} catch (e) {
			new Notice((e as Error).message);
		}
	}

	private async finishRedirect(code?: string) {
		if (!code || !this.pending) return void new Notice("That sign-in link is not one this plugin started.");
		const { verifier } = this.pending;
		this.pending = null;
		try {
			await this.signedIn(await this.gateway().finishHandback(code, verifier));
		} catch (e) {
			new Notice((e as Error).message);
		}
	}

	async signOut() {
		await this.disconnect();
		await this.gateway().signOut();
		this.data = { ...this.data, token: "", session: "", user: "", via: "", connected: false };
		this.user = "";
		this.signin = { kind: "not_set_up" };
		this.render(describe(this.signin).bar);
		await this.saveData(this.data);
	}

	/**
	 * The server says this device is not signed in (revoked by an admin, or the token changed). It is
	 * not signed in again by itself: that would undo a revoke. The person is told, with one button.
	 */
	private lostSession() {
		if (this.signin.kind === "ended") return;
		this.setSignIn({ kind: "ended", user: this.data.user, via: this.data.via });
		new Notice("agent-wiki: your sign-in on this device ended. Click the status bar to sign in again; your edits are kept.", 15000);
	}

	/** The one action on the "sign-in ended" screen: sign in again the way this device did before. */
	async signInAgain() {
		const via = this.data.via;
		if (via === "token" || !via) {
			if (!this.data.token) return void new Notice("Enter your token below to sign in.");
			return this.signInToken(this.data.token);
		}
		const p = (await this.gateway().providers().catch(() => null))?.providers.find((x) => x.id === via);
		if (!p) return void new Notice(`${via} sign-in is not offered by the server any more. Sign in another way below.`);
		return this.signInProvider(p);
	}

	// ------------------------------------------------------------------ the live vault

	get stateStore(): StatePort {
		return vaultState(this.data, () => void this.saveData(this.data));
	}

	/** Open the live connection; a Reconnect while one is opening joins it, and a new one replaces the old. */
	async connect() {
		try {
			await this.holder.connect(() => this.openSession());
		} catch (e) {
			if (!(e instanceof Handled)) throw e;
		}
	}

	private async openSession(): Promise<LiveSession> {
		const fail = (msg: string, ms = 15000): never => {
			this.connected = false;
			this.render("not connected");
			new Notice(`agent-wiki: ${msg}`, ms);
			throw new Handled();
		};
		this.connected = false;
		if (!this.data.url || !this.data.vault) {
			new Notice("Choose a server and a vault in the plugin settings first.");
			throw new Handled();
		}
		const g = this.gateway();
		let remote: HocuspocusRemote | null = null;
		try {
			const state = await this.refreshSignIn();
			if (state.kind !== "signed_in") throw new Handled(); // the status bar already says why; edits stay on this device
			const info = (await g.vaults()).find((v) => v.name === this.data.vault);
			if (!info) throw new Error(`You cannot open "${this.data.vault}" (it may not be live, or you have no access).`);
			this.render("connecting…");
			remote = new HocuspocusRemote({
				url: g.wsUrl,
				vault: info.name,
				user: this.user,
				token: async () => (await g.ticket(info.name)).ticket,
				fileOps: g.fileOps(info.name),
				readOnly: info.read_only,
				onRefused: (reason) => { this.render(`stopped: ${reason}`); new Notice(`agent-wiki: ${reason}`); },
				onStatus: (s) => this.render(s === "connected" ? (info.read_only ? "connected (read only)" : "connected") : s),
			});
			await remote.synced();
			const vs = new VaultSync(new VaultDisk(this.app), remote, this.stateStore, { notify: (n) => new Notice(n.message, 12000), log: (m, d) => console.debug("[agent-wiki-live]", m, d) }, { isOpen: (p) => this.binder.openPaths().has(p) });
			await vs.start();
			const session = new LiveSession(remote, vs);
			this.watch(session);
			this.connected = true;
			this.data.connected = true;
			await this.saveData(this.data);
			this.render(`${info.read_only ? "connected (read only)" : "connected"} · ${vs.size} notes`);
			return session;
		} catch (e) {
			remote?.destroy();
			if (e instanceof Handled) throw e;
			return fail(e instanceof NonEmptyFolderError ? e.message : (e as Error).message);
		}
	}

	/** Everything the session listens to or runs is owned by it, so it all ends with it. */
	private watch(session: LiveSession) {
		const host = new Component();
		this.addChild(host);
		session.own(() => this.removeChild(host));
		const md = (f: unknown): f is TFile => f instanceof TFile && f.extension === "md";
		const vs = session.vs;
		host.registerEvent(this.app.vault.on("modify", (f) => md(f) && void vs.fileChanged(f.path)));
		host.registerEvent(this.app.vault.on("create", (f) => md(f) && void vs.fileCreated(f.path)));
		host.registerEvent(this.app.vault.on("delete", (f) => md(f) && void vs.fileDeleted(f.path)));
		host.registerEvent(this.app.vault.on("rename", (f, old) => md(f) && void vs.fileRenamed(old, f.path)));
		const bind = () => void this.binder.refresh();
		host.registerEvent(this.app.workspace.on("active-leaf-change", bind));
		host.registerEvent(this.app.workspace.on("file-open", bind));
		host.registerEvent(this.app.workspace.on("layout-change", bind));
		// notes attach in the background; bind editors as they appear
		host.registerInterval(window.setInterval(bind, 2000));
		session.own(() => this.binder.unbindAll());
		bind();
	}

	async disconnect(persist = true) {
		await this.holder.disconnect();
		this.connected = false;
		if (persist) {
			this.data.connected = false;
			await this.saveData(this.data);
		}
		this.render("not connected");
	}
}

/** A failure already reported to the person (a notice or the status bar). */
class Handled extends Error {}
