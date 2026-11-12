// Bundle the React client into client/dist with esbuild, and compile the
// shadcn/Tailwind stylesheet with the Tailwind CLI (the client has no Vite
// or CSS loader — esbuild only bundles JavaScript).
//
// Output:
//   dist/app.js        — bundled, minified, sourcemapped React client
//   dist/index.html    — copied verbatim
//   dist/app.css       — the hand-written component stylesheet (copied)
//   dist/globals.css   — Tailwind utilities + shadcn theme tokens (compiled)
//   dist/plugins.css   — the plugin surface stylesheet (copied)

import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { cp } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)));
const client = resolve(root, "core", "client");
const dist = resolve(client, "dist");

// `dist` is created in place rather than removed: the pi runtime holds a
// recursive file watcher over the workspace, and `rm -rf dist` makes that
// watcher throw `ENOENT: scandir …/client/dist` and crash the whole session.
// Every file in dist is one of the outputs written below, so no stale files
// accumulate from skipping the directory delete.
if (!existsSync(dist)) {
  mkdirSync(dist, { recursive: true });
}

await build({
  entryPoints: [resolve(client, "app.tsx")],
  bundle: true,
  format: "esm",
  outdir: dist,
  // Code-splitting keeps lazily-imported libraries (mermaid) out of the main
  // bundle as a separate chunk, fetched only when a diagram actually renders.
  splitting: true,
  minify: true,
  sourcemap: true,
  jsx: "automatic",
  target: "es2022",
  logLevel: "info",
  // Match the `@/*` tsconfig paths so shadcn components import from
  // `@/components/ui/…` and `@/lib/utils` without a bundler config file.
  alias: { "@": client },
});

const tailwindBin = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss");
execFileSync(
  tailwindBin,
  ["-i", resolve(client, "globals.css"), "-o", resolve(dist, "globals.css"), "--minify"],
  { stdio: "inherit" },
);

await cp(resolve(client, "index.html"), resolve(dist, "index.html"));
await cp(resolve(client, "base.css"), resolve(dist, "app.css"));
await cp(resolve(client, "plugin-system", "plugins.css"), resolve(dist, "plugins.css"));