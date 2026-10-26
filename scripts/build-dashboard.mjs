#!/usr/bin/env node
/**
 * Build the dashboard browser bundle into web/dashboard/dist/app.js.
 *
 * Everything is local: esbuild bundles Graphviz's WebAssembly build (the wasm
 * payload is embedded in @viz-js/viz), marked, DOMPurify and a highlight.js
 * language subset. No CDN or native graphviz binary is involved, and the build
 * works offline once `npm install` has populated node_modules.
 */
import { build } from "esbuild";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const dashboardDir = join(root, "web", "dashboard");
const distDir = join(dashboardDir, "dist");
const entry = join(dashboardDir, "src", "app.mjs");
const outfile = join(distDir, "app.js");

const started = Date.now();
await rm(distDir, { recursive: true, force: true });
await mkdir(distDir, { recursive: true });

const result = await build({
  entryPoints: [entry],
  outfile,
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  minify: true,
  sourcemap: false,
  legalComments: "none",
  charset: "utf8",
  logLevel: "warning",
  metafile: true,
});

const info = await stat(outfile);
const bundle = await readFile(outfile, "utf8");
const relativeOut = relative(root, outfile);

// Guard against accidentally shipping a network-loaded asset. The Graphviz
// wasm must stay embedded; a stray `http(s)://` import/fetch in our own bundle
// would break offline use, so fail the build loudly.
const suspicious = [...bundle.matchAll(/https?:\/\/[^\s"'`)\\]+/g)]
  .map((match) => match[0])
  .filter((url) => /cdn|unpkg|jsdelivr|esm\.sh|skypack/i.test(url));
if (suspicious.length > 0) {
  throw new Error(`dashboard bundle references external CDN assets: ${suspicious.slice(0, 5).join(", ")}`);
}
if (/\.wasm["'`]/.test(bundle) && !/AGFzbQ/.test(bundle)) {
  // viz-js embeds the wasm as base64; a bare .wasm URL means the build would
  // need a second asset file the runtime does not serve.
  throw new Error("dashboard bundle appears to reference an external .wasm file");
}

const bytes = info.size;
const elapsed = Date.now() - started;
const inputs = Object.keys(result.metafile?.inputs || {}).length;
console.log(`built ${relativeOut} (${(bytes / 1024 / 1024).toFixed(2)} MiB, ${inputs} inputs, ${elapsed}ms)`);
