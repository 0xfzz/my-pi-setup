// The fixture project owns its build: output stays inside its own dist folder.
import { build } from "esbuild";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const outdir = resolve(root, "dist");
mkdirSync(outdir, { recursive: true });
await build({
  entryPoints: [resolve(root, "browser/index.ts")],
  outfile: resolve(outdir, "browser.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  logLevel: "warning",
});
console.log("fixture-e2e browser half built");
