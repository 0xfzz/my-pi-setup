/** Build the shared browser modules that external plugin bundles import. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundleWithinBudget, INITIAL_BUNDLE_BUDGETS } from "./bundle-budget.mjs";
import { FIRST_PARTY_EXTERNALS, HOST_MODULES, HOST_SPECIFIERS } from "./plugin-host-specifiers.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const host = resolve(root, "core/client/host");
const out = resolve(root, "core/client/dist/host");
const chunks = resolve(out, "chunks");

mkdirSync(out, { recursive: true });
mkdirSync(chunks, { recursive: true });
// Hash-named chunks from an older build are never referenced again. Remove the
// files, not the directory: the pi runtime watches this tree while building.
for (const entry of await readdir(chunks, { withFileTypes: true })) {
  if (entry.isFile()) await unlink(resolve(chunks, entry.name));
}

const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  // Host modules are ESM entry points: their exports cannot be tree-shaken.
  // Splitting keeps dynamic imports (mermaid, viewer renderers) in lazy chunks
  // instead of inlining megabytes into every page load.
  splitting: true,
  outdir: out,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  alias: { "@": resolve(root, "core/client") },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  metafile: true,
};

async function buildEntry(name, source, external = []) {
  const result = await build({
    ...options,
    external,
    entryPoints: { [name]: resolve(host, source) },
  });
  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    const file = basename(path);
    if (Object.hasOwn(INITIAL_BUNDLE_BUDGETS, file)) assertBundleWithinBudget(file, output.bytes);
  }
}

await buildEntry("runtime", "runtime.ts");
await buildEntry("ui", "ui.ts", FIRST_PARTY_EXTERNALS);
await buildEntry("icons", "icons.ts");
// The vendor packages themselves must be bundled here; only React and the
// other shared host modules stay external so there is one React instance.
await buildEntry(
  "file-viewer",
  "file-viewer.ts",
  HOST_SPECIFIERS.filter((specifier) => !specifier.startsWith("@file-viewer/")),
);

/** Each shared specifier has one tiny shim over its host bundle. */
const shims = {
  react: 'export * from "./runtime.js";\nexport { ReactDefault as default } from "./runtime.js";\n',
  "react/jsx-runtime": 'export { jsx, jsxs, JSXFragment as Fragment } from "./runtime.js";\n',
  "react-dom": 'export { createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule, requestFormReset, unstable_batchedUpdates, useFormState, useFormStatus, version, ReactDOM as default } from "./runtime.js";\n',
  "react-dom/client": 'export { createRoot, hydrateRoot } from "./runtime.js";\n',
  "@phosphor-icons/react": 'export * from "./icons.js";\n',
  "@file-viewer/react": 'export { FileViewer, FileViewerDefault as default, useFileViewerState } from "./file-viewer.js";\n',
  "@file-viewer/core": 'export { setDefaultFileViewerAssetBaseUrl } from "./file-viewer.js";\n',
  "@file-viewer/preset-office": 'export { officePresetDefault as default } from "./file-viewer.js";\n',
  "@pi-web/bridge": 'export * from "./runtime.js";\n',
  "@pi-web/bridge/text": 'export { webUiText } from "./runtime.js";\n',
};

for (const specifier of HOST_SPECIFIERS) {
  const source = shims[specifier];
  if (source === undefined) continue; // @pi-web/host-ui is the ui.js bundle itself.
  writeFileSync(resolve(out, HOST_MODULES[specifier]), source, "utf8");
}

console.log("[build] host runtime modules");
