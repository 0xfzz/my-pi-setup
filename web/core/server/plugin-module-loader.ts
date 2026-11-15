// Loading a plugin's server half so that a reload actually re-imports it.
//
// A plain `import(url)` is cached by URL for the life of the process: asking
// for the same plugin again returns the module the host already has, with its
// module-level state intact. The plugin manager would report "reloaded" while
// every line of the plugin — its entry and its own sibling modules — kept
// running the code it was first imported with. An operator who edits a plugin
// and reloads it sees the old version, which is exactly the version skew this
// module exists to remove.
//
// Each load therefore gets a generation, and every module *inside the plugin's
// own directory* resolves with `?v=<generation>`: the entry re-evaluates, and
// so do the plugin's own imports. Modules outside that directory — the core
// files policy, the kernel, this host — keep their identity, because a plugin
// MUST share those instances with the server that runs it. That boundary is why
// this is a scoped resolve hook rather than a cache reset.

import * as nodeModule from "node:module";
import { pathToFileURL } from "node:url";

/**
 * `module.registerHooks` (Node >= 22.15). Read off the namespace rather than
 * imported by name: a runtime without it would fail at link time, and the
 * fallback below is what keeps this working there.
 */
const registerHooks = (nodeModule as { registerHooks?: (hooks: ResolveHooks) => unknown }).registerHooks;

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
  format?: string | null;
}

interface ResolveContext {
  parentURL?: string | undefined;
}

interface ResolveHooks {
  resolve(
    specifier: string,
    context: ResolveContext,
    nextResolve: (specifier: string, context: ResolveContext) => ResolveResult,
  ): ResolveResult;
}

/** What one plugin's modules are keyed by: its directory, plus the generation. */
const generations = new Map<string, number>();
let counter = 0;
let installed = false;

/** The URL a plugin module is imported from: the same file, a new generation. */
function withGeneration(url: string): string {
  // Longest directory wins, so a plugin nested inside another is keyed by its own.
  const match = [...generations.keys()]
    .sort((a, b) => b.length - a.length)
    .find((dir) => {
      const prefix = pathToFileURL(dir).href;
      return url === prefix || url.startsWith(`${prefix}/`);
    });
  if (match === undefined) return url;
  const scoped = new URL(url);
  scoped.searchParams.set("v", String(generations.get(match)));
  return scoped.href;
}

/** Install the scoped resolve hook once per process. */
function install(): void {
  if (installed || registerHooks === undefined) return;
  installed = true;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const resolved = nextResolve(specifier, context);
      // Only a resolved file URL is ours to rewrite; builtins and bare
      // specifiers pass through untouched.
      if (!resolved.url.startsWith("file:")) return resolved;
      return { ...resolved, url: withGeneration(resolved.url) };
    },
  });
}

/**
 * Import a plugin's server entry as a fresh module tree.
 *
 * `entryPath` is the absolute path of the manifest's `main.server`; `pluginDir`
 * is the directory that module tree belongs to. Without the hook (an older
 * Node), the entry is still re-imported with a query — a single-file plugin
 * reloads correctly, a plugin with siblings keeps their first version.
 */
export async function importPluginModule(entryPath: string, pluginDir: string): Promise<object> {
  generations.set(pluginDir, ++counter);
  install();

  const url = pathToFileURL(entryPath).href;
  const scoped = registerHooks === undefined ? `${url}?v=${counter}` : url;
  const mod = (await import(scoped)) as { default?: object };
  return mod.default ?? mod;
}

/** Test-only: forget every generation so a suite starts from a clean cache. */
export function clearPluginModuleGenerationsForTests(): void {
  generations.clear();
  counter = 0;
}
