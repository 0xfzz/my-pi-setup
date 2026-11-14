// The plugin kernel host: discovery of user/project/package plugins, enable
// state, capabilities, hooks, services and routes.
//
// One host per process. This module imports no plugin: the composition root
// registers the built-in descriptor list, keeping the dependency one-way
// (plugins → core, core ↛ plugins).

import { homedir, tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import { createPluginHost, type PluginHost } from "../plugin-contracts/kernel/host.ts";

const GLOBAL_HOST_KEY = Symbol.for("pi-web:plugin-host:v1");

/** The first-party plugin tree, which is also a discovery root (Files ships a manifest). */
const webPluginsDir = fileURLToPath(new URL("../../plugins", import.meta.url));

/**
 * How long the registry may wait for the kernel to finish booting before it
 * answers with whatever is active. Activation is budgeted per plugin, so this
 * only bounds the pathological case of many slow plugins at once.
 */
const PLUGIN_READY_TIMEOUT_MS = 10_000;

/** Test processes get their own state file so a suite never writes into a real home directory. */
function defaultPluginStatePath(): string {
  return process.env.NODE_TEST_CONTEXT
    ? join(tmpdir(), "pi-web-plugin-state", `${process.pid}.json`)
    : join(homedir(), ".pi", "agent", "web-plugins.json");
}

/** The manifest fields the loader reads from a discovered plugin. */
interface DiscoveredPluginLike {
  dir: string;
  manifest: { main?: { server?: string } };
}

/**
 * Load a plugin's server half by native dynamic import, not a bundling or
 * isolated loader: a plugin imports core modules (the fs policy, this host),
 * and those imports MUST resolve to the same module instances the host already
 * holds. An isolated loader would give the plugin a second copy of the kernel's
 * state.
 */
async function loadPluginRuntime(plugin: DiscoveredPluginLike): Promise<object> {
  const entry = plugin.manifest.main?.server;
  if (!entry) return {};
  const url = pathToFileURL(join(plugin.dir, entry)).href;
  const mod = (await import(url)) as { default?: object };
  return mod.default ?? mod;
}

function globalHosts(): Record<PropertyKey, unknown> {
  return globalThis as Record<PropertyKey, unknown>;
}

let registry: PluginHost<WebPluginDescriptor> | null = null;

/**
 * Register the built-in descriptor list so the host can serve `/api/plugins`
 * and gate actions. Called from the server composition root (web/server.ts),
 * never from `web/plugins/`. Idempotent, and Symbol.for-guarded against double
 * evaluation.
 */
export function registerWebPlugins(
  descriptors: readonly WebPluginDescriptor[],
): PluginHost<WebPluginDescriptor> {
  const global = globalHosts();
  const existing = global[GLOBAL_HOST_KEY] as PluginHost<WebPluginDescriptor> | undefined;
  if (existing !== undefined) {
    registry = existing;
    return existing;
  }

  const host = createPluginHost<WebPluginDescriptor>({
    descriptors,
    descriptorDir: webPluginsDir,
    statePath: process.env.PI_WEB_PLUGIN_STATE ?? defaultPluginStatePath(),
    roots: {
      // First-party plugins may ship a real manifest (pi-web-plugin.json) with a
      // server half — the Files plugin does — so the repo tree is a discovery
      // root exactly like a user or project directory.
      repo: webPluginsDir,
      user: join(homedir(), ".pi", "agent", "web-plugins"),
      project: join(process.cwd(), ".pi", "web-plugins"),
    },
    env: process.env,
    loader: loadPluginRuntime,
  });

  global[GLOBAL_HOST_KEY] = host;
  registry = host;

  host.ready.catch((error: unknown) => {
    console.error("[pi-web-minimal] web plugin host failed to boot:", error);
  });

  return host;
}

/** Active kernel host instance, or null when registerWebPlugins has not run yet. */
export function getPluginHost(): PluginHost<WebPluginDescriptor> | null {
  return registry;
}

/** Undefined while the plugin is switched off, quarantined, or hidden. */
export function getPluginDescriptor(id: string): WebPluginDescriptor | undefined {
  return registry?.descriptor(id);
}

/** The minimum a registry read needs from a booting host. */
export interface BootableRegistry {
  readonly ready: Promise<unknown>;
  visible(): readonly WebPluginDescriptor[];
}

/** Resolve when `ready` settles or the deadline passes — never reject. */
async function settleWithin(ready: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  try {
    await Promise.race([ready.catch(() => undefined), deadline]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * The descriptors to serve. `visible()` hides every plugin that is not active
 * yet, so answering before the kernel has booted tells the client "no plugins"
 * for a whole page load — and the client fetches the registry exactly once.
 * Waiting for boot (bounded) is what makes that single fetch correct.
 */
export async function visiblePluginsWhenReady(
  host: BootableRegistry,
  timeoutMs: number = PLUGIN_READY_TIMEOUT_MS,
): Promise<readonly WebPluginDescriptor[]> {
  await settleWithin(host.ready, timeoutMs);
  return host.visible();
}

/** The served registry, after boot. Empty when no host is registered yet. */
export async function pluginsWhenReady(): Promise<readonly WebPluginDescriptor[]> {
  const host = registry;
  return host === null ? [] : visiblePluginsWhenReady(host);
}
