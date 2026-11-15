import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "node:fs";

const prod = process.argv[2] !== "dev";
await esbuild.build({
	entryPoints: ["src/main.ts"],
	bundle: true,
	format: "cjs",
	platform: "browser", // runs in Obsidian desktop and mobile: no Node built-ins
	target: "es2020",
	external: ["obsidian", "electron", "@codemirror/state", "@codemirror/view", "@codemirror/language", "@codemirror/commands", "@lezer/common", "@lezer/highlight", "@lezer/lr"],
	outfile: "main.js",
	sourcemap: prod ? false : "inline",
	minify: prod,
	logLevel: "info",
	legalComments: "linked",
});
mkdirSync("dist/agent-wiki-live", { recursive: true });
for (const f of ["main.js", "manifest.json", "styles.css"]) copyFileSync(f, `dist/agent-wiki-live/${f}`);
