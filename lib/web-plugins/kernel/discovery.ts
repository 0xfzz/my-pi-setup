/**
 * Discovery (PRD R20, §6.6): find `pi-web-plugin.json` manifests under the four
 * roots, validate them without running any plugin code, and choose one winner
 * per id. Precedence is project > user > package > repo. Losers are kept in
 * `shadowed` so the plugin manager can list them in diagnostics.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseManifestText, type PluginManifest } from "./manifest.ts";

export const PLUGIN_SOURCES = ["project", "user", "package", "repo"] as const;
export type PluginSource = (typeof PLUGIN_SOURCES)[number];

/** Lower index wins a duplicate id. */
const RANK: Record<PluginSource, number> = { project: 0, user: 1, package: 2, repo: 3 };

export const MANIFEST_FILE = "pi-web-plugin.json";

export interface DiscoveredPlugin {
  id: string;
  source: PluginSource;
  /** Absolute directory that holds the manifest; entry paths resolve against it. */
  dir: string;
  manifest: PluginManifest;
}

export interface Shadowed {
  id: string;
  source: PluginSource;
  dir: string;
  shadowedBy: PluginSource;
}

export interface DiscoveryResult {
  selected: DiscoveredPlugin[];
  shadowed: Shadowed[];
  diagnostics: string[];
}

export interface DiscoveryRoots {
  repo?: string;
  user?: string;
  project?: string;
  /** Pi package directories whose package.json lists `pi.webPlugins`. */
  packages?: readonly string[];
}

/** Read one manifest from a directory. Never executes anything. */
export function readManifestDir(dir: string, source: PluginSource): { ok: true; plugin: DiscoveredPlugin } | { ok: false; error: string } {
  const file = join(dir, MANIFEST_FILE);
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { ok: false, error: `${file}: cannot read manifest (${(error as NodeJS.ErrnoException).code ?? String(error)})` };
  }
  const parsed = parseManifestText(text);
  if (!parsed.ok) return { ok: false, error: `${file}: ${parsed.error}` };
  return { ok: true, plugin: { id: parsed.manifest.id, source, dir: resolve(dir), manifest: parsed.manifest } };
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** Every immediate subdirectory of `root` that contains a manifest, or a diagnostic for a broken one. */
export function scanRoot(root: string, source: PluginSource): { plugins: DiscoveredPlugin[]; diagnostics: string[] } {
  const plugins: DiscoveredPlugin[] = [];
  const diagnostics: string[] = [];
  if (!isDirectory(root)) return { plugins, diagnostics };
  for (const entry of readdirSync(root).sort()) {
    const dir = join(root, entry);
    if (!isDirectory(dir) || !existsSync(join(dir, MANIFEST_FILE))) continue;
    const result = readManifestDir(dir, source);
    if (result.ok) plugins.push(result.plugin);
    else diagnostics.push(`rejected (${source}): ${result.error}`);
  }
  return { plugins, diagnostics };
}

/**
 * The `pi.webPlugins` entries of a pi package: relative directories inside the
 * package. Anything absolute or escaping the package is ignored with a diagnostic.
 */
export function packageWebPluginDirs(packageDir: string): { dirs: string[]; diagnostics: string[] } {
  const diagnostics: string[] = [];
  let pkg: unknown;
  try {
    pkg = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
  } catch {
    return { dirs: [], diagnostics };
  }
  const list = (pkg as { pi?: { webPlugins?: unknown } } | null)?.pi?.webPlugins;
  if (list === undefined) return { dirs: [], diagnostics };
  if (!Array.isArray(list) || !list.every((entry) => typeof entry === "string")) {
    diagnostics.push(`${packageDir}/package.json: pi.webPlugins must be an array of relative directories`);
    return { dirs: [], diagnostics };
  }
  const dirs: string[] = [];
  for (const entry of list) {
    if (entry.startsWith("/") || entry.split(/[\\/]/).includes("..")) {
      diagnostics.push(`${packageDir}: pi.webPlugins entry "${entry}" must stay inside the package`);
      continue;
    }
    dirs.push(resolve(packageDir, entry));
  }
  return { dirs, diagnostics };
}

export function discoverPlugins(roots: DiscoveryRoots): DiscoveryResult {
  const found: DiscoveredPlugin[] = [];
  const diagnostics: string[] = [];

  const add = (scan: { plugins: DiscoveredPlugin[]; diagnostics: string[] }) => {
    found.push(...scan.plugins);
    diagnostics.push(...scan.diagnostics);
  };
  if (roots.repo) add(scanRoot(roots.repo, "repo"));
  if (roots.user) add(scanRoot(roots.user, "user"));
  if (roots.project) add(scanRoot(roots.project, "project"));
  for (const packageDir of roots.packages ?? []) {
    const listed = packageWebPluginDirs(packageDir);
    diagnostics.push(...listed.diagnostics);
    for (const dir of listed.dirs) {
      const result = readManifestDir(dir, "package");
      if (result.ok) found.push(result.plugin);
      else diagnostics.push(`rejected (package): ${result.error}`);
    }
  }

  const ordered = [...found].sort((a, b) => RANK[a.source] - RANK[b.source] || a.dir.localeCompare(b.dir));
  const winners = new Map<string, DiscoveredPlugin>();
  const shadowed: Shadowed[] = [];
  for (const plugin of ordered) {
    const winner = winners.get(plugin.id);
    if (!winner) {
      winners.set(plugin.id, plugin);
      continue;
    }
    shadowed.push({ id: plugin.id, source: plugin.source, dir: plugin.dir, shadowedBy: winner.source });
    diagnostics.push(`shadowed (${plugin.source}): "${plugin.id}" at ${plugin.dir} is overridden by ${winner.source} ${winner.dir}`);
  }

  return {
    selected: [...winners.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
    shadowed,
    diagnostics,
  };
}
