import { MarkdownView, Menu, setIcon, type App } from "obsidian";
import type { VaultSync } from "../engine/VaultSync.ts";
import type { State } from "../state/connection.ts";
import { Presenter } from "../state/presenter.ts";
import { barExtras, noteState, type Mark, type Shown } from "../state/syncStatus.ts";

/** One icon per state; the shape differs, so colour is never the only signal. */
const ICON: Record<Exclude<Mark, "none">, string> = {
	synced: "cloud-check",
	saving: "refresh-cw",
	opening: "cloud-download",
	offline: "cloud-off",
	unreachable: "cloud-off",
	conflict: "triangle-alert",
};

type Slot = { el: HTMLElement; path: string; presenter: Presenter; shown: Shown };

/**
 * Draws the sync state: one small icon in each note's header actions, and the status bar's counts. It decides nothing: the mark
 * comes from `noteState`, the timing from `Presenter`, the facts from the engine.
 */
export class Indicator {
	private slots = new WeakMap<MarkdownView, Slot>();
	private all = new Set<Slot>();
	private timer: ReturnType<typeof setTimeout> | null = null;
	private app: App;
	private state: () => State;
	private vs: () => VaultSync | null;
	private extra: { reconnect: () => void };
	private onBar: () => void;

	constructor(app: App, state: () => State, vs: () => VaultSync | null, extra: { reconnect: () => void }, onBar: () => void) {
		this.app = app;
		this.state = state;
		this.vs = vs;
		this.extra = extra;
		this.onBar = onBar;
	}

	/** The status bar's counts (empty when there is nothing to say). */
	barExtras(): string {
		const vs = this.vs();
		return vs ? barExtras(this.state().conn, vs.summary()) : "";
	}

	/** Redraw soon: many changes in a row (every keystroke) are drawn once. */
	schedule() {
		if (this.timer) return;
		this.timer = setTimeout(() => {
			this.timer = null;
			this.refresh();
		}, 0);
	}

	refresh() {
		this.onBar();
		const vs = this.vs();
		const conn = this.state().conn;
		const seen = new Set<MarkdownView>();
		this.app.workspace.iterateAllLeaves((leaf) => {
			const view = leaf.view;
			if (!(view instanceof MarkdownView)) return;
			seen.add(view);
			const path = view.file?.path;
			let slot = this.slots.get(view);
			if (!path) return void (slot && (slot.el.dataset.sync = "none"));
			if (!slot) slot = this.attach(view, path);
			else if (slot.path !== path) {
				slot.presenter.dispose();
				this.all.delete(slot);
				slot = this.attach(view, path, slot.el);
			}
			slot.presenter.push(noteState(conn, vs?.facts(path) ?? null));
		});
	}

	private attach(view: MarkdownView, path: string, el?: HTMLElement): Slot {
		const slot: Slot = { el: el ?? view.addAction("cloud-check", "Sync status", (ev) => this.menu(slot, ev)), path, shown: { mark: "none", sentence: "", loud: false }, presenter: null as unknown as Presenter };
		slot.el.addClass("agent-wiki-sync");
		slot.el.dataset.sync = "none";
		slot.presenter = new Presenter((s) => this.draw(slot, s));
		this.slots.set(view, slot);
		this.all.add(slot);
		return slot;
	}

	private draw(slot: Slot, s: Shown) {
		slot.shown = s;
		slot.el.dataset.sync = s.mark;
		if (s.mark === "none") return;
		setIcon(slot.el, ICON[s.mark]);
		slot.el.setAttr("aria-label", s.sentence);
		slot.el.setAttr("title", s.sentence);
	}

	/** The one thing a click or tap does: say the sentence, in a small menu beside the icon. No modal, no toast. */
	private menu(slot: Slot, ev: MouseEvent) {
		const m = new Menu();
		m.addItem((i) => i.setTitle(slot.shown.sentence).setIcon(ICON[slot.shown.mark as Exclude<Mark, "none">] ?? "cloud").setDisabled(true));
		const sum = this.vs()?.summary();
		if (sum && (sum.waiting > 0 || sum.conflicts > 0)) m.addItem((i) => i.setTitle([sum.waiting && `${sum.waiting} waiting`, sum.conflicts && `${sum.conflicts} conflict${sum.conflicts === 1 ? "" : "s"}`].filter(Boolean).join(" · ") + " in this vault").setDisabled(true));
		if (slot.shown.mark === "offline" || slot.shown.mark === "unreachable") m.addItem((i) => i.setTitle("Reconnect now").onClick(() => this.extra.reconnect()));
		m.showAtMouseEvent(ev);
	}

	/** Removes every icon and timer (the plugin unloads). */
	destroy() {
		if (this.timer) clearTimeout(this.timer);
		for (const s of this.all) {
			s.presenter.dispose();
			s.el.remove();
		}
		this.all.clear();
	}
}
