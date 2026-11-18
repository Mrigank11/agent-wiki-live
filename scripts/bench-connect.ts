// Times the plugin's connect against the real gateway and sync server: N notes, an injected round trip, a first
// connect (empty folder) and a restart (same folder, saved records).
//   WIKIGW_BIN=<wikigw> N=600 LAT=250 node --experimental-strip-types scripts/bench-connect.ts
import { Stack } from "../../live-server/e2e/stack.ts";
import { Gateway, type Http } from "../src/live/gateway.ts";
import { HocuspocusRemote } from "../src/live/remote.ts";
import { VaultSync } from "../src/engine/VaultSync.ts";
import { MemDisk, MemState } from "../test/support.ts";

const N = Number(process.env.N ?? 600), LAT = Number(process.env.LAT ?? 0);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const http: Http = async (r) => {
	await sleep(LAT); // one round trip per HTTP call
	const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body });
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k] = v));
	const sc = res.headers.getSetCookie?.();
	if (sc?.length) headers["set-cookie"] = sc.join(", ");
	return { status: res.status, headers, text: await res.text() };
};
/** A WebSocket whose incoming messages arrive LAT ms late (in order): a round trip of about LAT. */
class Laggy extends WebSocket {
	addEventListener(type: string, h: any, o?: any) {
		if (type !== "message") return super.addEventListener(type, h, o);
		const w = (ev: MessageEvent) => setTimeout(() => (typeof h === "function" ? h.call(this, ev) : h.handleEvent(ev)), LAT);
		h.__laggy = w;
		return super.addEventListener(type, w as any, o);
	}
	removeEventListener(type: string, h: any, o?: any) {
		return super.removeEventListener(type, (type === "message" && h?.__laggy) || h, o);
	}
}
const files: Record<string, string> = {};
for (let i = 0; i < N; i++) files[`notes/n${i}.md`] = `# Note ${i}\n\n` + "Some text that a person wrote. ".repeat(40) + "\n";
const stack = new Stack({ files, quiet: 1500, max: 6000, onePort: true });
await stack.start();
const disk = new MemDisk(), state = new MemState();
async function connect(label: string) {
	const t: Record<string, number> = {};
	let t0 = performance.now();
	const lap = (k: string) => { const n = performance.now(); t[k] = Math.round(n - t0); t0 = n; };
	const g = new Gateway(stack.adminUrl, http);
	g.device = "bench";
	await g.loginToken("tok-ada"); lap("signIn");
	await g.whoami(); lap("signInCheck");
	const info = (await g.vaults()).find((v) => v.name === "main")!; lap("vaultList");
	const remote = new HocuspocusRemote({ url: g.wsUrl, vault: "main", user: "ada", token: async () => (await g.ticket("main")).ticket, fileOps: g.fileOps("main"), readOnly: info.read_only, WebSocketPolyfill: Laggy });
	await remote.synced(60000); lap("fileIndex");
	const vs = new VaultSync(disk, remote, state, { notify: () => {} }, { settleMs: 50 });
	await vs.start(); lap("editable");
	await vs.attached(); lap("allNotesOpen");
	const sum = (...k: string[]) => k.reduce((a, x) => a + t[x], 0);
	console.log(JSON.stringify({ label, notes: vs.size, rttMs: LAT, ms: t, editableAfterMs: sum("signInCheck", "vaultList", "fileIndex", "editable"), fullyOpenAfterMs: sum("signInCheck", "vaultList", "fileIndex", "editable", "allNotesOpen") }));
	vs.stop();
	remote.destroy();
}
try {
	await connect("first connect, empty folder");
	await connect("restart, same folder");
} finally {
	await stack.stop();
}
process.exit(0);
