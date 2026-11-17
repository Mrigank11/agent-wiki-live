// The live session's lifetime: what the previous connection leaves behind must not touch the vault
// (the 2026-11-17 incident: Reconnect left a stopped engine listening, and one new note became 401 files).
import { test } from "node:test";
import assert from "node:assert/strict";
import { Client, startEnv, uniq, type Env } from "../../live-server/test/helpers.ts";
import { LiveSession, SessionHolder, type FileEvents, type VaultEvents } from "../src/engine/LiveSession.ts";
import { NonEmptyFolderError } from "../src/engine/VaultSync.ts";
import { vaultState } from "../src/engine/vaultState.ts";
import { MemDisk, MemState, settled, startPlugin } from "./support.ts";

async function withEnv(fn: (env: Env) => Promise<void>, files: Record<string, string> = {}) {
	const env = await startEnv({}, files);
	try {
		await fn(env);
	} finally {
		await env.close();
	}
}

/** The notes the sync server holds, read through a fresh connection. */
async function serverPaths(env: Env) {
	const c = await Client.connect(env, "observer");
	try {
		const out: string[] = [];
		(c.index.doc.getMap("files") as any).forEach((v: { path: string; deleted?: number }) => !v.deleted && out.push(v.path));
		return out.sort();
	} finally {
		await c.close();
	}
}

/** Obsidian's vault events as the plugin sees them: handlers live until their owner takes them away. */
class Bus implements VaultEvents {
	handlers = new Set<FileEvents>();
	subscribe(h: FileEvents) {
		this.handlers.add(h);
		return () => void this.handlers.delete(h);
	}
	/** A person creates a file in Obsidian: it lands on disk and every handler hears about it. */
	create(disk: MemDisk, path: string, text: string) {
		disk.files.set(path, text);
		for (const h of [...this.handlers]) void h.changed(path);
	}
}

test("a stopped engine ignores file events: it cannot create notes behind the live connection's back", async () => {
	await withEnv(async (env) => {
		const disk = new MemDisk();
		const p = await startPlugin(env, "mrigank", { disk, echo: false });
		p.vs.stop();
		disk.files.set("Late.md", "# late\n");
		await p.vs.fileChanged("Late.md");
		await p.vs.fileCreated("Late.md");
		await p.vs.fileRenamed("Late.md", "Later.md");
		await p.vs.fileDeleted("Later.md");
		assert.deepEqual(await serverPaths(env), [], "no note was created on the server");
		p.remote.destroy();
	});
});

/** Open a session on the bus the way the plugin does on Connect or Reconnect. */
async function open(env: Env, disk: MemDisk, state: MemState, bus: Bus) {
	const p = await startPlugin(env, "mrigank", { disk, state, echo: false });
	const s = new LiveSession(p.remote, p.vs);
	s.watch(bus);
	return s;
}

test("Reconnect twice, then one new note: exactly one note on the server and one file on disk", async () => {
	await withEnv(async (env) => {
		const disk = new MemDisk();
		const state = new MemState();
		const bus = new Bus();
		const holder = new SessionHolder();
		for (let i = 0; i < 3; i++) await holder.connect(() => open(env, disk, state, bus));
		assert.equal(bus.handlers.size, 1, "only the current session listens to the vault");

		const name = `${uniq("note")}.md`;
		bus.create(disk, name, "# hello\n");
		await holder.current!.vs.idle();
		assert.deepEqual(await serverPaths(env), [name]);
		assert.deepEqual([...disk.files.keys()], [name], "no copies on disk");
		await holder.disconnect();
		assert.equal(bus.handlers.size, 0, "disconnect takes every listener away");
	});
});

test("connect is single-flight: two Reconnects at once open one session", async () => {
	await withEnv(async (env) => {
		const disk = new MemDisk();
		const state = new MemState();
		const bus = new Bus();
		const holder = new SessionHolder();
		let opened = 0;
		const make = async () => {
			opened++;
			return open(env, disk, state, bus);
		};
		await Promise.all([holder.connect(make), holder.connect(make), holder.connect(make)]);
		assert.equal(opened, 1);
		assert.equal(bus.handlers.size, 1);
		await holder.disconnect();
	});
});

test("disconnect while a connect is still opening leaves nothing running", async () => {
	await withEnv(async (env) => {
		const disk = new MemDisk();
		const state = new MemState();
		const bus = new Bus();
		const holder = new SessionHolder();
		const c = holder.connect(() => open(env, disk, state, bus));
		await holder.disconnect();
		await c;
		assert.equal(holder.current, null);
		assert.equal(bus.handlers.size, 0);
	});
});

test("switching vault: the old vault's notes are never uploaded into the new one", async () => {
	await withEnv(async (envA) => {
		await withEnv(async (envB) => {
			const disk = new MemDisk({ "Alpha.md": "# alpha\n", "Gamma.md": "# gamma\n" });
			// the plugin's saved data, as main.ts keeps it
			const data = { vault: "a", notesVault: "", notes: {} as Record<string, { path: string; base: string }> };
			const saved: string[] = [];
			const store = () => vaultState(data, () => saved.push(data.vault));

			const a = await startPlugin(envA, "mrigank", { disk, state: store(), adoptExisting: true });
			await settled(a, "both notes attached", () => a.vs.size === 2);
			a.stop();
			assert.ok(Object.keys(data.notes).length === 2, "vault A's notes are remembered");

			// the person picks vault B in settings and connects on the same folder
			data.vault = "b";
			let err: unknown = null;
			try {
				await startPlugin(envB, "mrigank", { disk, state: store(), adoptExisting: false });
			} catch (e) {
				err = e;
			}
			assert.ok(err instanceof NonEmptyFolderError, "a folder full of vault A's notes is refused, as any non-empty folder is");
			assert.deepEqual(await serverPaths(envB), [], "nothing was sent to vault B");
		});
	});
});

test("notes saved before vault scoping existed belong to the vault the plugin was set to", () => {
	const data = { vault: "a", notesVault: "" as string | undefined, notes: { x: { path: "X.md", base: "x" } } };
	const s = vaultState(data, () => {});
	assert.deepEqual(Object.keys(s.load()), ["x"]);
	data.vault = "b";
	assert.deepEqual(s.load(), {}, "and no other");
});
