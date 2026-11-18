/** Build every shared browser module declared in the single web registry. */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "node:fs";
import { access, readdir, unlink } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assertBundleWithinBudget } from "./bundle-budget.mjs";
import { registry } from "./load-registry.mjs";

const {
  HOST_BUNDLES,
  HOST_BUNDLE_EXTERNALS,
  HOST_MODULE_TABLE,
  HOST_MODULES,
  HOST_SHIMS,
  LEGACY_CORE_HOST_FILES,
} = registry;

const root = dirname(fileURLToPath(import.meta.url));
const dist = resolve(root, "core/client/dist");

// Create in place and replace files, never remove a watched directory.
for (const outdir of new Set(Object.values(HOST_BUNDLES).map((bundle) => bundle.outdir))) {
  const out = resolve(dist, outdir);
  mkdirSync(out, { recursive: true });
  const chunks = resolve(out, "chunks");
  mkdirSync(chunks, { recursive: true });
  // Hash-named chunks from an older build are never referenced again.
  for (const entry of await readdir(chunks, { withFileTypes: true })) {
    if (entry.isFile()) await unlink(resolve(chunks, entry.name));
  }
}

// The viewer bundle moved into the files plugin; drop its old core-owned
// generated files so a served /host/ URL cannot keep pointing at stale code.
for (const file of LEGACY_CORE_HOST_FILES) {
  const stale = resolve(dist, "host", file);
  try {
    await access(stale);
    await unlink(stale);
  } catch {
    // Already gone.
  }
}

const options = {
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
  jsx: "automatic",
  // Entry exports cannot be tree-shaken. Splitting keeps dynamic imports
  // (mermaid, viewer renderers) in lazy chunks instead of the entry bundle.
  splitting: true,
  chunkNames: "chunks/[name]-[hash]",
  alias: { "@": resolve(root, "core/client") },
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "warning",
  metafile: true,
};

async function buildEntry(name) {
  const bundle = HOST_BUNDLES[name];
  const result = await build({
    ...options,
    outdir: resolve(dist, bundle.outdir),
    external: HOST_BUNDLE_EXTERNALS[bundle.external],
    entryPoints: { [name]: resolve(root, bundle.source) },
  });
  for (const [path, output] of Object.entries(result.metafile.outputs)) {
    const file = basename(path);
    if (Object.hasOwn(registry.INITIAL_BUNDLE_BUDGETS, file)) {
      assertBundleWithinBudget(file, output.bytes);
    }
  }
}

for (const name of Object.keys(HOST_BUNDLES)) await buildEntry(name);

for (const [specifier, source] of Object.entries(HOST_SHIMS)) {
  const bundleName = HOST_MODULE_TABLE[specifier].bundle;
  const outdir = resolve(dist, HOST_BUNDLES[bundleName].outdir, HOST_MODULES[specifier]);
  writeFileSync(outdir, source, "utf8");
}

console.log("[build] host runtime modules");
