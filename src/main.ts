import { Notice, Plugin, requestUrl, TFile } from "obsidian";
import { NonEmptyFolderError, VaultSync } from "./engine/VaultSync.ts";
import type { NoteRecord, StatePort } from "./engine/types.ts";
import { Gateway, GatewayError, type Http, type ProviderInfo } from "./live/gateway.ts";
import { HocuspocusRemote } from "./live/remote.ts";
import { EditorBinder } from "./obsidian/editor.ts";
import { LiveSettingTab } from "./obsidian/settings.ts";
import { VaultDisk } from "./obsidian/vaultDisk.ts";

type Data = { url: string; token: string; session: string; user: string; vault: string; connected: boolean; notes: Record<string, NoteRecord> };
const EMPTY: Data = { url: "", token: "", session: "", user: "", vault: "", connected: false, notes: {} };

const http: Http = async (r) => {
	const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
	return { status: res.status, headers: res.headers, text: res.text };
};

export default class AgentWikiLive extends Plugin {
	data: Data = { ...EMPTY };
	user = "";
	connected = false;
	statusText = "";
	private gw: Gateway | null = null;
	private vs: VaultSync | null = null;
	private remote: HocuspocusRemote | null = null;
	private status!: HTMLElement;
	private binder!: EditorBinder;
	private pending: { verifier: string } | null = null;
	private tick: number | null = null;

	async onload() {
		this.data = { ...EMPTY, ...(await this.loadData()) };
		this.user = this.data.user;
		this.status = this.addStatusBarItem();
		this.binder = new EditorBinder(this.app, () => this.vs);
		this.registerEditorExtension(this.binder.extension);
		this.addSettingTab(new LiveSettingTab(this.app, this));
		this.registerObsidianProtocolHandler("agent-wiki-live-signin", (params) => void this.finishRedirect(params.code));
		this.addCommand({ id: "reconnect", name: "Reconnect to agent-wiki", callback: () => void this.connect() });
		this.render("not connected");
		this.app.workspace.onLayoutReady(() => {
			if (this.data.connected && this.data.vault) void this.connect();
		});
	}

	onunload() {
		void this.disconnect(false);
	}

	gateway() {
		if (!this.gw || this.gw.base !== this.data.url.replace(/\/+$/, "")) {
			this.gw = new Gateway(this.data.url, http);
			this.gw.session = this.data.session;
			this.gw.onSignedOut = () => void this.lostSession();
		}
		return this.gw;
	}

	private render(text: string) {
		this.statusText = text;
		this.status.setText(`agent-wiki: ${text}`);
	}

	// ------------------------------------------------------------------ sign-in

	private async signedIn(who: { name: string }) {
		this.user = this.data.user = who.name;
		this.data.session = this.gateway().session;
		await this.saveData(this.data);
		new Notice(`Signed in as ${who.name}.`);
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
		this.data = { ...this.data, token: "", session: "", user: "", connected: false };
		this.user = "";
		await this.saveData(this.data);
	}

	/** The session ended (12 hours idle, or revoked): sign in again with the saved token if there is one. */
	private async lostSession() {
		if (this.data.token) {
			try {
				await this.signedIn(await this.gateway().loginToken(this.data.token));
				return;
			} catch {
				/* fall through */
			}
		}
		this.render("signed out: sign in again in settings");
	}

	// ------------------------------------------------------------------ the live vault

	get stateStore(): StatePort {
		return { load: () => this.data.notes, save: (n) => { this.data.notes = n; void this.saveData(this.data); } };
	}

	async connect() {
		if (this.vs) await this.disconnect(false);
		if (!this.data.url || !this.data.vault) return void new Notice("Choose a server and a vault in the plugin settings first.");
		const g = this.gateway();
		try {
			if (!(await g.whoami().catch(() => null))) {
				if (!this.data.token) return this.render("signed out: sign in again in settings");
				await this.signedIn(await g.loginToken(this.data.token));
			}
			const info = (await g.vaults()).find((v) => v.name === this.data.vault);
			if (!info) throw new Error(`You cannot open "${this.data.vault}" (it may not be live, or you have no access).`);
			this.render("connecting…");
			const remote = new HocuspocusRemote({
				url: g.wsUrl,
				vault: info.name,
				user: this.user,
				token: async () => (await g.ticket(info.name)).ticket,
				fileOps: g.fileOps(info.name),
				readOnly: info.read_only,
				onRefused: (reason) => { this.render(`stopped: ${reason}`); new Notice(`agent-wiki: ${reason}`); },
				onStatus: (s) => this.render(s === "connected" ? (info.read_only ? "connected (read only)" : "connected") : s),
			});
			this.remote = remote;
			await remote.synced();
			const vs = new VaultSync(new VaultDisk(this.app), remote, this.stateStore, { notify: (n) => new Notice(n.message, 12000), log: (m, d) => console.debug("[agent-wiki-live]", m, d) }, { isOpen: (p) => this.binder.openPaths().has(p) });
			this.vs = vs;
			await vs.start();
			this.connected = true;
			this.data.connected = true;
			await this.saveData(this.data);
			this.watch(vs);
			this.render(`${info.read_only ? "connected (read only)" : "connected"} · ${vs.size} notes`);
		} catch (e) {
			this.remote?.destroy();
			this.remote = null;
			this.vs = null;
			this.connected = false;
			const msg = e instanceof NonEmptyFolderError ? e.message : (e as Error).message;
			this.render("not connected");
			new Notice(`agent-wiki: ${msg}`, 15000);
		}
	}

	private watch(vs: VaultSync) {
		const md = (f: unknown): f is TFile => f instanceof TFile && f.extension === "md";
		this.registerEvent(this.app.vault.on("modify", (f) => md(f) && void vs.fileChanged(f.path)));
		this.registerEvent(this.app.vault.on("create", (f) => md(f) && void vs.fileCreated(f.path)));
		this.registerEvent(this.app.vault.on("delete", (f) => md(f) && void vs.fileDeleted(f.path)));
		this.registerEvent(this.app.vault.on("rename", (f, old) => md(f) && void vs.fileRenamed(old, f.path)));
		const bind = () => void this.binder.refresh();
		this.registerEvent(this.app.workspace.on("active-leaf-change", bind));
		this.registerEvent(this.app.workspace.on("file-open", bind));
		this.registerEvent(this.app.workspace.on("layout-change", bind));
		// notes attach in the background; bind editors as they appear
		this.tick = window.setInterval(bind, 2000);
		this.registerInterval(this.tick);
		bind();
	}

	async disconnect(persist = true) {
		if (this.tick) window.clearInterval(this.tick);
		this.tick = null;
		this.binder?.unbindAll();
		this.vs?.stop();
		this.vs = null;
		this.remote?.destroy();
		this.remote = null;
		this.connected = false;
		if (persist) {
			this.data.connected = false;
			await this.saveData(this.data);
		}
		this.render("not connected");
	}
}
