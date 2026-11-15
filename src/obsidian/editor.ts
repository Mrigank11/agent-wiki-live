import { Compartment, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { yCollab } from "y-codemirror.next";
import { Awareness } from "y-protocols/awareness";
import { MarkdownView, type App } from "obsidian";
import type { VaultSync } from "../engine/VaultSync.ts";

/**
 * Binds each open note's editor to its live text (cursors, names, edits as you type). The binding is a
 * CodeMirror extension in one shared compartment, reconfigured per editor. Binding never edits the note
 * unless the editor and the live text differ, and then it makes the editor match the live text.
 */
export class EditorBinder {
	readonly compartment = new Compartment();
	private bound = new WeakMap<EditorView, string>();
	private app: App;
	private vs: () => VaultSync | null;
	private busy = false;

	constructor(app: App, vs: () => VaultSync | null) {
		this.app = app;
		this.vs = vs;
	}

	get extension(): Extension {
		return this.compartment.of([]);
	}

	/** Paths shown in an open editor right now. */
	openPaths(): Set<string> {
		const out = new Set<string>();
		this.app.workspace.iterateAllLeaves((l) => {
			if (l.view instanceof MarkdownView && l.view.file) out.add(l.view.file.path);
		});
		return out;
	}

	async refresh() {
		const vs = this.vs();
		if (!vs || this.busy) return;
		this.busy = true;
		try {
			const jobs: Promise<void>[] = [];
			this.app.workspace.iterateAllLeaves((l) => {
				if (l.view instanceof MarkdownView && l.view.file) jobs.push(this.one(vs, l.view, l.view.file.path));
			});
			await Promise.all(jobs);
		} finally {
			this.busy = false;
		}
	}

	private async one(vs: VaultSync, view: MarkdownView, path: string) {
		const cm = (view.editor as unknown as { cm?: EditorView }).cm;
		if (!cm || this.bound.get(cm) === path) return;
		const note = vs.note(path);
		if (!note) return this.unbind(cm);
		await vs.ready(path); // merge any pending outside edit first, so the editor and live text agree
		if (cm.state.doc.toString() !== note.text) cm.dispatch({ changes: { from: 0, to: cm.state.doc.length, insert: note.text } });
		const awareness = note.live.awareness ?? new Awareness(note.live.doc);
		cm.dispatch({ effects: this.compartment.reconfigure(yCollab(note.live.text, awareness)) });
		this.bound.set(cm, path);
	}

	private unbind(cm: EditorView) {
		if (this.bound.has(cm)) {
			cm.dispatch({ effects: this.compartment.reconfigure([]) });
			this.bound.delete(cm);
		}
	}

	/** Called when a note is closed, renamed or the plugin disconnects: drop every binding. */
	unbindAll() {
		this.app.workspace.iterateAllLeaves((l) => {
			const cm = l.view instanceof MarkdownView ? (l.view.editor as unknown as { cm?: EditorView }).cm : undefined;
			if (cm) this.unbind(cm);
		});
	}
}
