/** Build the shared browser runtime that external plugin bundles import. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { HOST_MODULES, HOST_SPECIFIERS } from "./plugin-host-specifiers.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const host = resolve(root, "core/client/host");
const out = resolve(root, "core/client/dist/host");

mkdirSync(out, { recursive: true });

const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  // Host modules are ESM entry points: their exports cannot be tree-shaken.
  // Splitting keeps dynamic imports (mermaid, the file viewer) in lazy chunks
  // instead of inlining megabytes into every page load.
  splitting: true,
  outdir: out,
  entryNames: "[name]",
  chunkNames: "chunks/[name]-[hash]",
  alias: { "@": resolve(root, "core/client") },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
};

await build({
  ...options,
  entryPoints: { runtime: resolve(host, "runtime.ts") },
});

await build({
  ...options,
  external: HOST_SPECIFIERS,
  entryPoints: { ui: resolve(host, "ui.ts") },
});

/** Each shared specifier has one tiny shim over the single runtime bundle. */
const shims = {
  react: 'export * from "./runtime.js";\nexport { ReactDefault as default } from "./runtime.js";\n',
  "react/jsx-runtime": 'export { jsx, jsxs, JSXFragment as Fragment } from "./runtime.js";\n',
  "react-dom": 'export { createPortal, flushSync, preconnect, prefetchDNS, preinit, preinitModule, preload, preloadModule, requestFormReset, unstable_batchedUpdates, useFormState, useFormStatus, version, ReactDOM as default } from "./runtime.js";\n',
  "react-dom/client": 'export { createRoot, hydrateRoot } from "./runtime.js";\n',
  "@phosphor-icons/react": 'export * from "./runtime.js";\n',
  "@file-viewer/react": 'export { FileViewer, FileViewerDefault as default, useFileViewerState } from "./runtime.js";\n',
  "@file-viewer/core": 'export { setDefaultFileViewerAssetBaseUrl } from "./runtime.js";\n',
  "@file-viewer/preset-office": 'export { officePresetDefault as default } from "./runtime.js";\n',
  "@pi-web/bridge": 'export * from "./runtime.js";\n',
  "@pi-web/bridge/text": 'export { webUiText } from "./runtime.js";\n',
};

for (const specifier of HOST_SPECIFIERS) {
  const source = shims[specifier];
  if (source === undefined) continue; // @pi-web/host-ui is the ui.js bundle itself.
  writeFileSync(resolve(out, HOST_MODULES[specifier]), source, "utf8");
}

console.log("[build] host runtime modules");
