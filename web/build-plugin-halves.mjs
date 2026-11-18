/** Build each manifest-declared browser half into its own ES module. */
import { build } from "esbuild";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { FIRST_PARTY_EXTERNALS } from "./plugin-host-specifiers.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const plugins = resolve(root, "plugins");

const external = FIRST_PARTY_EXTERNALS;

for (const name of readdirSync(plugins, { withFileTypes: true })) {
  if (!name.isDirectory()) continue;
  const dir = join(plugins, name.name);
  const manifestPath = join(dir, "pi-web-plugin.json");
  if (!existsSync(manifestPath)) continue;
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const browser = manifest.main?.browser;
  if (browser === undefined) continue;

  const source = join(dir, "browser/index.ts");
  if (!existsSync(source)) throw new Error(`browser half ${name.name} has no browser/index.ts`);
  const outfile = resolve(dir, browser);
  mkdirSync(dirname(outfile), { recursive: true });

  await build({
    entryPoints: [source],
    outfile,
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    jsx: "automatic",
    splitting: false,
    external,
    alias: { "@": resolve(root, "core/client") },
    loader: { ".css": "text" },
    define: { "process.env.NODE_ENV": '"production"' },
    logLevel: "warning",
  });
  console.log(`[build] ${name.name} browser half`);
}
