// The plugin kernel host: discovery of user/project/package plugins, enable
// state, capabilities, hooks, services and routes.
//
// One host per process. This module imports no plugin: the composition root
// registers the built-in descriptor list, keeping the dependency one-way
// (plugins → core, core ↛ plugins).

import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import type { WebPluginDescriptor } from "../plugin-contracts/descriptor.ts";
import { createPluginHost, type PluginHost } from "../plugin-contracts/kernel/host.ts";
import type { DiscoveryRoots } from "../plugin-contracts/kernel/discovery.ts";
import { createPluginUiSink } from "./plugin-ui-sink.ts";
import { importPluginModule } from "./plugin-module-loader.ts";
import { tryGetWebLogger } from "../http/logging.ts";
import { pluginProjectRoots } from "../../../lib/plugin-project.ts";

const GLOBAL_HOST_KEY = Symbol.for("pi-web:plugin-host:v1");

/** Boot diagnostics raised before the composition root installs its logger. */
const pendingLogs: Array<(logger: NonNullable<ReturnType<typeof tryGetWebLogger>>) => void> = [];

function queueOrLog(write: (logger: NonNullable<ReturnType<typeof tryGetWebLogger>>) => void): void {
  const logger = tryGetWebLogger();
  if (logger === undefined) pendingLogs.push(write);
  else write(logger);
}

function recordPluginWarning(message: string): void {
  queueOrLog((logger) => logger.warn({ warning: message }, "web plugin host warning"));
}

/** Called after the server logger exists so startup diagnostics are not lost. */
export function flushPluginHostWarnings(): void {
  const logger = tryGetWebLogger();
  if (logger === undefined) return;
  for (const write of pendingLogs.splice(0)) write(logger);
}

/** The first-party plugin tree, which is also a discovery root (Files ships a manifest). */
const webPluginsDir = fileURLToPath(new URL("../../plugins", import.meta.url));

export interface WebPluginDiscoveryDirs {
  readonly repo: string;
  readonly user: string;
  readonly project: string;
}

function defaultDiscoveryDirs(): WebPluginDiscoveryDirs {
  return {
    repo: webPluginsDir,
    user: join(homedir(), ".pi", "agent", "web-plugins"),
    project: join(process.cwd(), ".pi", "web-plugins"),
  };
}

/** External package roots are opt-in; without the env var discovery is unchanged. */
export function webPluginDiscoveryRoots(
  env: Record<string, string | undefined>,
  dirs: WebPluginDiscoveryDirs = defaultDiscoveryDirs(),
): Pick<DiscoveryRoots, "repo" | "user" | "project" | "packages"> {
  return {
    repo: dirs.repo,
    user: dirs.user,
    project: dirs.project,
    packages: pluginProjectRoots(env),
  };
}

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

function pluginStatePath(): string {
  return process.env.PI_WEB_PLUGIN_STATE ?? defaultPluginStatePath();
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
 *
 * The import goes through `importPluginModule`, which gives the plugin's own
 * directory a new module generation per load. Without it the URL cache returns
 * the module a previous load already produced, so a plugin reload would keep
 * running its old code — and so would every module it imports itself.
 */
async function loadPluginRuntime(plugin: DiscoveredPluginLike): Promise<object> {
  const entry = plugin.manifest.main?.server;
  if (!entry) return {};
  return importPluginModule(join(plugin.dir, entry), plugin.dir);
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
    existing.ui.attach(createPluginUiSink());
    return existing;
  }

  const host = createPluginHost<WebPluginDescriptor>({
    descriptors,
    descriptorDir: webPluginsDir,
    statePath: pluginStatePath(),
    // Plugin storage sits beside the operator state, so a suite that points
    // PI_WEB_PLUGIN_STATE at a temp dir also redirects the storage file.
    storagePath: process.env.PI_WEB_PLUGIN_STORAGE ?? `${pluginStatePath()}.storage.json`,
    roots: webPluginDiscoveryRoots(process.env),
    env: process.env,
    loader: loadPluginRuntime,
    onWarning: recordPluginWarning,
  });

  global[GLOBAL_HOST_KEY] = host;
  registry = host;
  // The store is a server singleton; the kernel only knows the sink interface.
  host.ui.attach(createPluginUiSink());

  void host.ready.then((report) => {
    if (report.safeMode) {
      queueOrLog((logger) => logger.warn({ reason: report.safeModeReason ?? null }, "web plugin host entered safe mode"));
    }
    for (const [pluginId, error] of Object.entries(report.failed)) {
      queueOrLog((logger) => logger.error({ pluginId, error }, "web plugin failed to start"));
    }
    for (const pluginId of report.crashed) {
      queueOrLog((logger) => logger.error({ pluginId }, "web plugin crashed during boot"));
    }
  }, (error: unknown) => {
    queueOrLog((logger) => logger.error({ err: error }, "web plugin host failed to boot"));
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
