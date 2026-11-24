import { Component, Notice, Platform, Plugin, requestUrl, TFile } from "obsidian";
import { LiveSession, SessionHolder } from "./engine/LiveSession.ts";
import { VaultSync } from "./engine/VaultSync.ts";
import { GatewayKeeper, GatewayError, sameServer, type Http, type ProviderInfo } from "./live/gateway.ts";
import { Connector, Refusal, type OpenHooks } from "./state/connector.ts";
import { describe as describeState, Store, type Action } from "./state/connection.ts";
import { HocuspocusRemote } from "./live/remote.ts";
import { EditorBinder } from "./obsidian/editor.ts";
import { LiveSettingTab } from "./obsidian/settings.ts";
import { EMPTY, migrateLegacy, NoteFile, type Data, type FileStore } from "./obsidian/noteFile.ts";
import { VaultDisk } from "./obsidian/vaultDisk.ts";
import { Indicator } from "./obsidian/indicator.ts";

const http: Http = async (r) => {
	const res = await requestUrl({ url: r.url, method: r.method, headers: r.headers, body: r.body, throw: false });
	return { status: res.status, headers: res.headers, text: res.text };
};

export default class AgentWikiLive extends Plugin {
	data: Data = { ...EMPTY };
	user = "";
	/** The one answer to "am I signed in, am I connected, how far along". The status bar and settings only draw it. */
	store = new Store();
	private gws: GatewayKeeper | null = null;
	private holder = new SessionHolder();
	private connector!: Connector;
	private binder!: EditorBinder;
	private indicator!: Indicator;
	private pending: { verifier: string } | null = null;

	async onload() {
		const raw = ((await this.loadData()) ?? {}) as Record<string, unknown>;
		this.data = await migrateLegacy(raw, this.fileStore(), this.manifest.dir!);
		if ("notes" in raw || "notesVault" in raw || "connected" in raw) await this.saveData(this.data); // 0.2.x settings: the notes moved to their own file
		this.user = this.data.user;
		this.store = new Store({ conn: this.data.user ? { kind: "idle", user: this.data.user, via: this.data.via } : { kind: "setup" }, want: this.data.want, vault: this.data.vault, vaults: "loading", providers: null });
		this.connector = new Connector(this.store, {
			holder: this.holder,
			gateway: () => this.gateway(),
			saved: () => ({ user: this.data.user, via: this.data.via }),
			save: async (want) => {
				this.data.want = want;
				await this.saveData(this.data);
			},
			open: (hooks) => this.openSession(hooks),
			poke: () => this.holder.current?.remote.goOnline(),
		});

		this.indicator = new Indicator(this.app, () => this.store.get(), () => this.holder.current?.vs ?? null, { reconnect: () => void this.connector.reconnect() }, () => draw());
		this.register(() => this.indicator.destroy());
		const status = this.addStatusBarItem();
		status.addClass("mod-clickable");
		status.onClickEvent(() => this.openSettings());
		let was = "";
		const draw = () => {
			const s = this.store.get();
			status.setText(`agent-wiki: ${describeState(s).bar}${this.indicator.barExtras()}`);
			if (s.conn.kind === "stopped" && was !== "stopped") new Notice(`agent-wiki: ${s.conn.reason}`, 15000);
			was = s.conn.kind;
		};
		this.register(this.store.subscribe(() => (draw(), this.indicator.schedule()))); // the status bar follows the store at once, in step with the settings tab
		draw();
		this.indicator.schedule();

		this.binder = new EditorBinder(this.app, () => this.holder.current?.vs ?? null);
		this.registerEditorExtension(this.binder.extension);
		this.addSettingTab(new LiveSettingTab(this.app, this));
		this.registerObsidianProtocolHandler("agent-wiki-live-signin", (params) => void this.finishRedirect(params.code));
		this.addCommand({ id: "reconnect", name: "Reconnect to agent-wiki", callback: () => void this.connector.reconnect() });
		this.registerDomEvent(window, "online", () => this.connector.lifecycle("online"));
		this.registerDomEvent(document, "visibilitychange", () => document.visibilityState === "visible" && this.connector.lifecycle("foreground"));
		this.app.workspace.onLayoutReady(() => this.connector.lifecycle("layout-ready"));
	}

	onunload() {
		this.connector?.dispose(); // closes the session; the saved wish to be connected stays
	}

	// ------------------------------------------------------------------ what the settings tab asks of the plugin

	setUrl(url: string) {
		const moved = !sameServer(url, this.data.url);
		this.data.url = url;
		if (moved) {
			// the sign-in (cookie, name) belongs to the old server; the session goes with it, through the connector
			this.data.session = this.data.user = this.data.via = this.user = "";
			void this.saveData(this.data);
			this.connector.serverChanged();
		} else void this.saveData(this.data);
	}

	/** Ask the server about this device's sign-in, its sign-in methods and (when signed in) vaults; the answers go to the store. */
	refresh() {
		void (async () => {
			const who = await this.connector.checkSignIn();
			void this.connector.loadProviders();
			if (who.kind === "signed_in") await this.connector.loadVaults();
		})();
	}

	async checkServer() {
		this.store.dispatch({ t: "providers", list: (await this.gateway().providers()).providers });
	}

	async selectVault(name: string) {
		const c = this.store.get().conn.kind;
		if (name !== this.data.vault && (c === "live" || c === "connecting")) await this.connector.want(false); // the open connection is to the old vault
		this.data.vault = name;
		await this.saveData(this.data);
		this.store.dispatch({ t: "vault", name });
	}

	/** The one button of the connection row. */
	async act(action: Action) {
		if (action === "connect") await this.connector.want(true);
		else if (action === "disconnect" || action === "cancel") await this.connector.want(false);
		else if (action === "retry") this.connector.retryNow();
		else if (action === "signInAgain") await this.signInAgain();
	}

	gateway() {
		if (!this.gws) {
			this.gws = new GatewayKeeper(http, `Obsidian · ${this.app.vault.getName()}`);
			this.gws.onSignedOut = () => this.lostSession();
		}
		return this.gws.get(this.data.url, this.data.session);
	}

	/** Opens this plugin's settings (the status bar's click, and the "sign in again" notice). */
	openSettings() {
		const setting = (this.app as unknown as { setting?: { open(): void; openTabById(id: string): void } }).setting;
		setting?.open();
		setting?.openTabById(this.manifest.id);
	}

	// ------------------------------------------------------------------ sign-in

	private async signedIn(who: { name: string; via?: string }) {
		this.user = this.data.user = who.name;
		this.data.via = who.via ?? this.data.via;
		this.data.session = this.gateway().session;
		await this.saveData(this.data);
		new Notice(`Signed in as ${who.name}.`);
		this.connector.signedIn(who); // the edits kept while signed out sync again now
		void this.connector.loadVaults();
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
		await this.connector.want(false);
		await this.gateway().signOut();
		this.data = { ...this.data, token: "", session: "", user: "", via: "", want: false };
		this.user = "";
		this.store.dispatch({ t: "signin", result: { kind: "not_set_up" } });
		this.store.dispatch({ t: "vaults", list: "loading" });
		await this.saveData(this.data);
	}

	/**
	 * The server says this device is not signed in (revoked by an admin, or the token changed). It is
	 * not signed in again by itself: that would undo a revoke. The person is told, with one button.
	 */
	private lostSession() {
		if (this.store.get().conn.kind === "signed_out") return;
		this.connector.signedOut();
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

	/** The plugin folder's files, through the vault adapter (works on desktop and on phones). */
	private fileStore(): FileStore {
		const a = this.app.vault.adapter;
		return {
			read: async (p) => ((await a.exists(p)) ? a.read(p) : null),
			write: (p, t) => a.write(p, t),
			rename: async (from, to) => {
				if (await a.exists(to)) await a.remove(to);
				await a.rename(from, to);
			},
			remove: (p) => a.remove(p),
		};
	}

	/**
	 * Opens the live session for the connector: the socket and the file index first (then the vault is usable), the
	 * engine's first pass in the background. Anything the person must be told goes through `hooks`; the connector decides what it means.
	 */
	private async openSession(hooks: OpenHooks): Promise<LiveSession> {
		if (!this.data.url || !this.data.vault) throw new Refusal("Choose a server and a vault in the plugin settings first.");
		const g = this.gateway();
		const info = (await g.vaults()).find((v) => v.name === this.data.vault);
		if (!info) throw new Refusal(`You cannot open "${this.data.vault}" (it may not be live, or you have no access).`);
		hooks.phase("index");
		const remote = new HocuspocusRemote({
			url: g.wsUrl,
			vault: info.name,
			user: this.user,
			token: async () => (await g.ticket(info.name)).ticket,
			fileOps: g.fileOps(info.name),
			readOnly: info.read_only,
			onRefused: (reason) => hooks.refused(reason),
			onNetworkError: (reason) => hooks.unreachable(reason),
			onStatus: (s) => hooks.socket(s === "connected"),
		});
		try {
			await remote.synced(undefined, hooks.signal); // gives up at once when cancelled or refused, instead of after the index timeout
			const notes = await NoteFile.open(this.fileStore(), this.manifest.dir!, info.name);
			hooks.signal.throwIfAborted();
			const vs = new VaultSync(new VaultDisk(this.app), remote, notes, { notify: (n) => new Notice(n.message, 12000), log: (m, d) => console.debug("[agent-wiki-live]", m, d), progress: hooks.progress, attachFailed: hooks.attachFailed }, { isOpen: (p) => this.binder.openPaths().has(p), device: Platform.isMobile ? "phone" : "desktop" });
			await vs.start(); // returns once the first pass is queued: the vault is live, its notes attach in the background
			const session = new LiveSession(remote, vs);
			session.own(() => void notes.flush().catch((e) => console.debug("[agent-wiki-live] saving note memory failed", e)));
			this.watch(session);
			let live = 0;
			remote.index.forEach((e) => !e.deleted && live++);
			hooks.live(info.read_only, live);
			return session;
		} catch (e) {
			remote.destroy();
			throw e;
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
		session.own(vs.onStatus(() => this.indicator.schedule()));
		const bind = () => void (this.binder.refresh(), this.indicator.schedule());
		host.registerEvent(this.app.workspace.on("active-leaf-change", bind));
		host.registerEvent(this.app.workspace.on("file-open", bind));
		host.registerEvent(this.app.workspace.on("layout-change", bind));
		// notes attach in the background; bind editors as they appear
		host.registerInterval(window.setInterval(bind, 2000));
		session.own(() => this.binder.unbindAll());
		bind();
	}
}
