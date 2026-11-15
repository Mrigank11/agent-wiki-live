import { TFile, normalizePath, type App } from "obsidian";
import type { DiskPort } from "../engine/types.ts";

/** The vault's markdown notes, through Obsidian's own Vault API so its caches and other plugins stay in step. */
export class VaultDisk implements DiskPort {
	private app: App;
	constructor(app: App) {
		this.app = app;
	}
	private file(path: string) {
		const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f : null;
	}
	async list() {
		return this.app.vault.getMarkdownFiles().map((f) => f.path);
	}
	async read(path: string) {
		const f = this.file(path);
		return f ? this.app.vault.read(f) : null;
	}
	private async ensureFolder(path: string) {
		const dir = path.split("/").slice(0, -1).join("/");
		if (!dir || this.app.vault.getAbstractFileByPath(dir)) return;
		let acc = "";
		for (const part of dir.split("/")) {
			acc = acc ? `${acc}/${part}` : part;
			if (!this.app.vault.getAbstractFileByPath(acc)) await this.app.vault.createFolder(acc).catch(() => {});
		}
	}
	async write(path: string, text: string) {
		const f = this.file(path);
		if (f) return this.app.vault.modify(f, text);
		await this.ensureFolder(path);
		await this.app.vault.create(normalizePath(path), text);
	}
	async remove(path: string) {
		const f = this.file(path);
		if (f) await this.app.fileManager.trashFile(f);
	}
	async rename(from: string, to: string) {
		const f = this.file(from);
		if (!f) return;
		await this.ensureFolder(to);
		await this.app.vault.rename(f, normalizePath(to)); // a plain move: the server already rewrote any links
	}
}
