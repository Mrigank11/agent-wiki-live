import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type { ProviderInfo } from "../live/gateway.ts";
import { methodName } from "../live/signin.ts";
import { describe, type Action, type Store } from "../state/connection.ts";

/** What the settings tab needs from the plugin: the one store to draw, and the actions a person can take. */
export interface SettingsHost {
	store: Store;
	data: { url: string };
	setUrl(url: string): void;
	/** Ask the server about sign-in, sign-in methods and vaults; the answers arrive in the store. */
	refresh(): void;
	/** The Check button: ask the server which ways in it offers. */
	checkServer(): Promise<void>;
	signInToken(token: string): Promise<void>;
	signInProvider(p: ProviderInfo): Promise<void>;
	signOut(): Promise<void>;
	selectVault(name: string): Promise<void>;
	/** The one button of the connection row. */
	act(action: Action): Promise<void>;
}

/**
 * Draws the connection store and nothing else. `display()` is synchronous: it subscribes, asks the plugin to
 * refresh, and draws what the store holds right now; every change in the store draws the whole tab again
 * (keeping focus and what was typed), except a progress tick, which only moves the numbers: the buttons are not replaced, so a
 * click that is under way is not lost. It holds no state of its own about the connection, so it cannot disagree with the status bar.
 */
export class LiveSettingTab extends PluginSettingTab {
	private host: SettingsHost;
	private unsubscribe: (() => void) | null = null;
	private tokenText = "";
	/** What the tab was last drawn from (without the progress numbers), and the two elements a progress tick moves. */
	private drawnKey = "";
	private moving: { desc: HTMLElement; bar?: HTMLProgressElement } | null = null;

	constructor(app: App, host: SettingsHost & { manifest?: unknown }) {
		super(app, host as never);
		this.host = host;
	}

	display() {
		this.unsubscribe?.();
		this.unsubscribe = this.host.store.subscribe(() => this.onStoreChange());
		this.host.refresh();
		this.draw();
	}

	hide() {
		this.unsubscribe?.();
		this.unsubscribe = null;
	}

	/** The structure on screen: everything the tab is drawn from except how far along the progress is. */
	private keyOf(): string {
		const s = this.host.store.get();
		const c = s.conn;
		const copy = describe(s);
		return JSON.stringify([c.kind, "user" in c ? [c.user, c.via] : null, copy.title, copy.primary, copy.warn, !!copy.progress, copy.progress ? "" : copy.detail, s.vault, s.vaults, s.providers]);
	}

	/** A change in the store: draw the tab again, unless only the progress moved. */
	private onStoreChange() {
		if (this.moving && this.keyOf() === this.drawnKey) {
			const copy = describe(this.host.store.get());
			this.moving.desc.setText(copy.detail);
			if (this.moving.bar && copy.progress) {
				this.moving.bar.value = copy.progress.done;
				this.moving.bar.max = copy.progress.total;
			}
			return;
		}
		this.draw();
	}

	private draw() {
		const el = this.containerEl;
		this.drawnKey = this.keyOf();
		this.moving = null;
		// keep the cursor where the person had it
		const doc = (el as unknown as { ownerDocument?: Document }).ownerDocument;
		const active = doc?.activeElement as HTMLInputElement | null;
		const key = active && el.contains?.(active) ? active.dataset?.key : undefined;
		const caret = key ? [active!.selectionStart, active!.selectionEnd] : null;

		el.empty();
		const h = this.host;
		const s = h.store.get();
		const c = s.conn;
		el.createEl("h2", { text: "agent-wiki Live" });
		el.createEl("p", { text: "Edit your agent-wiki vault together with other people and agents. This Obsidian vault must be new and empty: it becomes a live copy of one agent-wiki vault.", cls: "setting-item-description" });

		new Setting(el).setName("Server address").setDesc("The address of your agent-wiki server, for example https://wiki.example.com")
			.addText((t) => {
				t.inputEl.dataset.key = "url";
				t.setValue(h.data.url).setPlaceholder("https://…");
				// the address is committed when the field is left, not on every keystroke: a half-typed address is not a new server
				t.inputEl.addEventListener("change", () => h.setUrl(t.inputEl.value.trim()));
			})
			.addButton((b) => b.setButtonText("Check").onClick(() => void h.checkServer().then(() => new Notice("Server found."), (e) => new Notice(`Could not reach the server: ${(e as Error).message}`))));

		if (c.kind === "setup") {
			this.signInForm(el);
		} else if (c.kind === "signed_out") {
			const copy = describe(s);
			const row = new Setting(el).setName(copy.title).setDesc(copy.detail);
			row.settingEl.addClass("mod-warning");
			row.addButton((b) => b.setButtonText(copy.primary!.label).setCta().onClick(() => void h.act(copy.primary!.action)));
			new Setting(el).setName("Use a different account").setDesc("Forget this sign-in and start over.").addButton((b) => b.setButtonText("Sign out").onClick(() => void h.signOut()));
		} else {
			new Setting(el).setName(`Signed in as ${c.user} via ${methodName(c.via)} · this device`).setDesc("This device stays signed in until you sign it out here or an admin does.")
				.addButton((b) => b.setButtonText("Sign out").onClick(() => void h.signOut()));
			this.vaultPicker(el);
			const copy = describe(s);
			const row = new Setting(el).setName(copy.title).setDesc(copy.detail);
			let bar: HTMLProgressElement | undefined;
			if (copy.progress) {
				bar = row.settingEl.createEl("progress", { cls: "agent-wiki-progress", attr: { value: copy.progress.done, max: copy.progress.total } });
				bar.value = copy.progress.done;
				bar.max = copy.progress.total;
			}
			this.moving = { desc: row.descEl, bar };
			const primary = copy.primary!;
			row.addButton((b) => b.setButtonText(primary.label).setCta().setDisabled(primary.action === "connect" && !s.vault).onClick(() => void h.act(primary.action)));
		}

		if (key) {
			const again = el.querySelector?.(`[data-key="${key}"]`) as HTMLInputElement | null;
			again?.focus();
			if (caret && caret[0] !== null) again?.setSelectionRange?.(caret[0], caret[1]);
		}
	}

	/** Every way in the server offers, shown at once: no Check press needed. */
	private signInForm(el: HTMLElement) {
		const h = this.host;
		const providers = h.store.get().providers;
		for (const prov of Array.isArray(providers) ? providers : []) {
			new Setting(el).setName(`Sign in with ${prov.name}`).addButton((b) => b.setButtonText(prov.name).onClick(() => void h.signInProvider(prov)));
		}
		new Setting(el).setName("Token").setDesc("The token an admin gave you. Kept on this device in the plugin's data file, in plain text.")
			.addText((t) => { t.inputEl.type = "password"; t.inputEl.dataset.key = "token"; t.setValue(this.tokenText).onChange((v) => (this.tokenText = v)); })
			.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => void h.signInToken(this.tokenText)));
		if (providers === "loading" && h.data.url) el.createEl("p", { text: "Looking for the sign-in methods the server offers…", cls: "setting-item-description" });
	}

	private vaultPicker(el: HTMLElement) {
		const h = this.host;
		const { vaults, vault } = h.store.get();
		const row = new Setting(el).setName("agent-wiki vault");
		if (vaults === "loading") return void row.setDesc("Looking for your vaults…");
		if ("error" in vaults) return void row.setDesc(`Could not list vaults: ${vaults.error}`);
		row.setDesc(vaults.length ? "Only live vaults you may open are listed." : "No live vault is available to you.");
		row.addDropdown((dd) => {
			dd.addOption("", "Choose…");
			for (const v of vaults) dd.addOption(v.name, v.read_only ? `${v.name} (read only)` : v.name);
			dd.setValue(vault).onChange((v) => void h.selectVault(v));
		});
	}
}
