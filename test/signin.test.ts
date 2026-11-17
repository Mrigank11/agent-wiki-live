// The plugin's view of its sign-in, against the REAL gateway: a named device stays signed in through a
// gateway restart (even a crash), an admin can sign it out, and the plugin then reports "ended" (not
// "signed in") while a server that is down reports "unreachable" (not "signed out").
import { test } from "node:test";
import assert from "node:assert/strict";
import { Stack } from "../../live-server/e2e/stack.ts";
import { Gateway, type Http } from "../src/live/gateway.ts";
import { describe, probe } from "../src/live/signin.ts";

const http: Http = async (r) => {
	const res = await fetch(r.url, { method: r.method, headers: r.headers, body: r.body, redirect: "manual" });
	const headers: Record<string, string> = {};
	res.headers.forEach((v, k) => (headers[k] = v));
	const sc = res.headers.getSetCookie?.();
	if (sc?.length) headers["set-cookie"] = sc.join(", ");
	return { status: res.status, headers, text: await res.text() };
};

test("a device sign-in survives a gateway crash, ends when an admin signs it out, and the plugin says so", async () => {
	const stack = new Stack({ quiet: 1200, max: 4000, onePort: true });
	await stack.start();
	try {
		const base = stack.adminUrl;
		const g = new Gateway(base, http);
		g.device = "Obsidian · test vault";
		const who = await g.loginToken("tok-ada");
		assert.equal(who.via, "token");
		const saved = { user: "ada", via: "token" };
		assert.equal((await probe(() => g.whoami(), saved)).kind, "signed_in");

		// the gateway is killed hard and started again: the sign-in is still good
		await stack.kill9("gateway");
		assert.equal((await probe(() => g.whoami(), saved)).kind, "unreachable", "a dead server is not a signed-out device");
		await stack.startGateway();
		assert.equal((await probe(() => g.whoami(), saved)).kind, "signed_in", "the sign-in survived the restart");

		// an admin signs this device out in the web UI's API
		const hdr = { "Content-Type": "application/json", "X-Requested-With": "agent-wiki-admin", Origin: base };
		const adm = await fetch(`${base}/api/admin/v1/session`, { method: "POST", headers: hdr, body: JSON.stringify({ token: "tok-admin" }) });
		assert.equal(adm.status, 200);
		const cookie = adm.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
		const list = await (await fetch(`${base}/api/admin/v1/users/ada/devices`, { headers: { ...hdr, Cookie: cookie } })).json() as { devices: { id: string; name: string }[] };
		assert.equal(list.devices.length, 1);
		assert.equal(list.devices[0].name, "Obsidian · test vault");
		const del = await fetch(`${base}/api/admin/v1/users/ada/devices/${list.devices[0].id}`, { method: "DELETE", headers: { ...hdr, Cookie: cookie } });
		assert.equal(del.status, 204);

		const state = await probe(() => g.whoami(), saved);
		assert.equal(state.kind, "ended");
		assert.match(describe(state).bar, /signed out/);
		// ...and it stays ended after another restart
		await stack.kill9("gateway");
		await stack.startGateway();
		assert.equal((await probe(() => g.whoami(), saved)).kind, "ended");
	} finally {
		await stack.stop();
	}
});

test("the states say what is true, with one action when there is one", () => {
	assert.equal(describe({ kind: "not_set_up" }).action, undefined);
	const ended = describe({ kind: "ended", user: "ada", via: "github" });
	assert.equal(ended.warn, true);
	assert.equal(ended.action, "Sign in again with GitHub");
	assert.equal(describe({ kind: "ended", user: "ada", via: "token" }).action, "Sign in again");
	assert.match(describe({ kind: "signed_in", user: "ada", via: "tailscale" }).title, /Signed in as ada via Tailscale/);
	assert.match(describe({ kind: "unreachable", user: "ada", via: "token" }).detail, /kept on this device/);
});
