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
import { createHash } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundleWithinBudget } from "./bundle-budget.mjs";
import { registry } from "./load-registry.mjs";

const { FILE_VIEWER_ASSETS, FIRST_PARTY_EXTERNALS, hostImportMap } = registry;

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

const clientBuild = await build({
  // The client entry is the top-level composition root, which imports the
  // core shell and the first-party plugin panel registrations. It lives
  // outside core so the core client never imports a plugin module.
  entryPoints: [resolve(root, "app.tsx")],
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
  external: FIRST_PARTY_EXTERNALS,
  metafile: true,
});
for (const [path, output] of Object.entries(clientBuild.metafile.outputs)) {
  if (path.endsWith("/app.js")) assertBundleWithinBudget("app.js", output.bytes);
}

execFileSync(process.execPath, [resolve(root, "build-host-modules.mjs")], { stdio: "inherit" });
execFileSync(process.execPath, [resolve(root, "build-plugin-halves.mjs")], { stdio: "inherit" });

const tailwindBin = resolve(root, "node_modules", ".bin", process.platform === "win32" ? "tailwindcss.cmd" : "tailwindcss");
execFileSync(
  tailwindBin,
  ["-i", resolve(client, "globals.css"), "-o", resolve(dist, "globals.css"), "--minify"],
  { stdio: "inherit" },
);

// The import map is generated from the same registry that builds the host
// shims, so adding a shared browser module never means editing two files.
const htmlTemplate = await readFile(resolve(client, "index.html"), "utf8");
const importMap = JSON.stringify({ imports: hostImportMap() }, null, 2);
const html = htmlTemplate.replace(
  "<!-- PI_WEB_IMPORT_MAP -->",
  `<script type="importmap">\n${importMap}\n  </script>`,
);
if (html === htmlTemplate) throw new Error("index.html import-map placeholder is missing");
await writeFile(resolve(dist, "index.html"), html);
await cp(resolve(client, "base.css"), resolve(dist, "app.css"));
// Shared panel styles stay in core; each plugin owns and injects its own CSS.
await cp(resolve(client, "plugin-system", "plugins.css"), resolve(dist, "plugins.css"));

// The files plugin owns its viewer assets and renderer list; this build only
// copies what its registry entry declares into the plugin's static path.
execFileSync(
  resolve(root, "node_modules", ".bin", process.platform === "win32" ? "file-viewer-copy-assets.cmd" : "file-viewer-copy-assets"),
  [resolve(dist, FILE_VIEWER_ASSETS.outdir), "--renderers", FILE_VIEWER_ASSETS.renderers.join(",")],
  { stdio: "inherit" },
);
// The build's identity, beside the assets it describes. `/app.js` is a fixed
// name, so a browser cannot tell from a response which build it is looking at:
// the server reports this id on /api/health and on the session directory's
// snapshot, and a page whose own bundle carries a different id reloads onto the
// current one. Hashed over the entry output, so any change to the bundle — or
// to a chunk it references — produces a new id.
const entry = resolve(dist, "app.js");
const digest = createHash("sha256");
digest.update(await readFile(entry));
digest.update(await readFile(resolve(dist, "index.html")));
const buildRecord = {
  buildId: digest.digest("hex").slice(0, 16),
  builtAt: new Date().toISOString(),
};
await writeFile(resolve(dist, "build.json"), `${JSON.stringify(buildRecord, null, 2)}\n`, "utf8");
console.log(`[build] client build ${buildRecord.buildId}`);
