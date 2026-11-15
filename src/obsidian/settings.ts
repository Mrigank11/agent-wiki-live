import { Notice, PluginSettingTab, Setting, type App } from "obsidian";
import type { ProviderInfo, VaultInfo } from "../live/gateway.ts";
import type AgentWikiLive from "../main.ts";

export class LiveSettingTab extends PluginSettingTab {
	private plugin: AgentWikiLive;
	private providers: ProviderInfo[] | null = null;
	private vaults: VaultInfo[] | null = null;
	private tokenText = "";

	constructor(app: App, plugin: AgentWikiLive) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display() {
		const el = this.containerEl;
		el.empty();
		const p = this.plugin;
		const d = p.data;
		el.createEl("h2", { text: "agent-wiki Live" });
		el.createEl("p", { text: "Edit your agent-wiki vault together with other people and agents. This Obsidian vault must be new and empty: it becomes a live copy of one agent-wiki vault.", cls: "setting-item-description" });

		new Setting(el).setName("Server address").setDesc("The address of your agent-wiki server, for example https://wiki.example.com").addText((t) => t.setValue(d.url).setPlaceholder("https://…").onChange(async (v) => { d.url = v.trim(); await p.saveData(d); }))
			.addButton((b) => b.setButtonText("Check").onClick(async () => {
				try {
					this.providers = (await p.gateway().providers()).providers;
					new Notice("Server found.");
					this.display();
				} catch (e) {
					new Notice(`Could not reach the server: ${(e as Error).message}`);
				}
			}));

		if (!p.user) {
			new Setting(el).setName("Token").setDesc("The token an admin gave you. Kept on this device in the plugin's data file, in plain text.").addText((t) => { t.inputEl.type = "password"; t.onChange((v) => (this.tokenText = v)); })
				.addButton((b) => b.setButtonText("Sign in").setCta().onClick(() => p.signInToken(this.tokenText).then(() => this.display())));
			for (const prov of this.providers ?? []) {
				new Setting(el).setName(`Sign in with ${prov.name}`).addButton((b) => b.setButtonText(prov.name).onClick(() => p.signInProvider(prov).then(() => this.display())));
			}
			if (!this.providers) el.createEl("p", { text: "Press Check to see which sign-in methods the server offers.", cls: "setting-item-description" });
		} else {
			new Setting(el).setName(`Signed in as ${p.user}`).addButton((b) => b.setButtonText("Sign out").onClick(async () => { await p.signOut(); this.display(); }));
			void this.vaultPicker(el);
		}
	}

	private async vaultPicker(el: HTMLElement) {
		const p = this.plugin;
		const d = p.data;
		if (!this.vaults) {
			try {
				this.vaults = await p.gateway().vaults();
			} catch (e) {
				el.createEl("p", { text: `Could not list vaults: ${(e as Error).message}` });
				return;
			}
		}
		const s = new Setting(el).setName("agent-wiki vault").setDesc(this.vaults.length ? "Only live vaults you may open are listed." : "No live vault is available to you.");
		s.addDropdown((dd) => {
			dd.addOption("", "Choose…");
			for (const v of this.vaults!) dd.addOption(v.name, v.read_only ? `${v.name} (read only)` : v.name);
			dd.setValue(d.vault).onChange(async (v) => { d.vault = v; await p.saveData(d); });
		});
		new Setting(el).setName(p.connected ? "Connected" : "Not connected").setDesc(p.statusText)
			.addButton((b) => b.setButtonText(p.connected ? "Disconnect" : "Connect").setCta().onClick(async () => { if (p.connected) await p.disconnect(); else await p.connect(); this.display(); }));
	}
}
