/**
 * Host facade: the one object the web server asks about plugins. It discovers
 * candidates, boots the manager, persists operator state, and answers which
 * descriptors may be shown or acted on. A descriptor whose plugin is disabled or
 * quarantined is hidden, and its actions are refused, in the same request.
 */
import { AuditLog } from "./audit.ts";
import { compatCandidates, type DescriptorLike } from "./compat.ts";
import { discoverPlugins, type DiscoveryRoots } from "./discovery.ts";
import { isCorePlugin, PluginManager, type BootReport, type PluginLoader, type PluginRuntime } from "./manager.ts";
import type { PluginState } from "./lifecycle.ts";
import { HookBus } from "./hooks.ts";
import { ServiceRegistry } from "./services.ts";
import { PluginStorage } from "./storage.ts";
import { loadState, saveState, type WebPluginsState } from "./state.ts";

/** States whose descriptor must not be shown or acted on. */
export const HIDDEN_STATES: ReadonlySet<PluginState> = new Set<PluginState>(["disabled", "quarantined", "rejected", "unresolved", "ignored"]);

export interface PluginHostOptions<D extends DescriptorLike> {
  descriptors: readonly D[];
  /** Directory the descriptors live in; reported as their source location. */
  descriptorDir: string;
  roots?: Pick<DiscoveryRoots, "user" | "project" | "packages">;
  statePath: string;
  env?: Record<string, string | undefined>;
  /** False when this evaluation is not a server start (see ManagerOptions.countStarts). */
  countStarts?: boolean;
  loader?: PluginLoader;
  now?: () => number;
}

export interface PluginHost<D extends DescriptorLike> {
  readonly manager: PluginManager;
  /** Logic hooks shared by every plugin; the host calls `waterfall`/`bail` at its call sites. */
  readonly hooks: HookBus;
  readonly services: ServiceRegistry;
  readonly storage: PluginStorage;
  /** Resolves once the manager has booted (activation done or failed for each plugin). */
  readonly ready: Promise<BootReport>;
  /** Non-fatal problems found while loading state or discovering plugins. */
  readonly warnings: readonly string[];
  /** Descriptors that may be shown right now. */
  visible(): D[];
  /** The descriptor for `id`, or undefined when its plugin is switched off or quarantined. */
  descriptor(id: string): D | undefined;
  shutdown(): Promise<void>;
}

const defaultLoader: PluginLoader = (plugin): PluginRuntime => {
  if (plugin.manifest.main.server || plugin.manifest.main.browser) {
    throw new Error(`no loader configured for code entry points of "${plugin.id}"`);
  }
  return {};
};

export function createPluginHost<D extends DescriptorLike>(options: PluginHostOptions<D>): PluginHost<D> {
  const warnings: string[] = [];
  const loaded = loadState(options.statePath);
  if (loaded.warning) warnings.push(loaded.warning);

  const discovered = discoverPlugins({
    ...options.roots,
    inline: compatCandidates(options.descriptors, options.descriptorDir),
  });
  warnings.push(...discovered.diagnostics);

  const audit = new AuditLog({ clock: options.now });
  const hooks = new HookBus();
  const services = new ServiceRegistry();
  const storage = new PluginStorage();
  const manager = new PluginManager({
    plugins: discovered.selected,
    state: loaded.state,
    loader: options.loader ?? defaultLoader,
    env: options.env ?? {},
    countStarts: options.countStarts,
    now: options.now,
    audit,
    hooks,
    services,
    storage,
    persist: (state: WebPluginsState) => {
      try {
        saveState(options.statePath, state);
      } catch (error) {
        warnings.push(`could not write ${options.statePath}: ${String(error)}`);
      }
    },
  });

  const byId = new Map(options.descriptors.map((d) => [d.id, d] as const));
  // Hidden when switched off or quarantined, and in safe mode unless the plugin is core and active.
  const hidden = (id: string): boolean => {
    const status = manager.snapshot().find((s) => s.id === id);
    if (status === undefined || HIDDEN_STATES.has(status.state)) return true;
    return manager.isSafeMode() && !isCorePlugin(id) && status.state !== "active";
  };

  return {
    manager,
    hooks,
    services,
    storage,
    ready: manager.start(),
    warnings,
    visible: () => options.descriptors.filter((d) => !hidden(d.id)),
    descriptor: (id) => {
      const descriptor = byId.get(id);
      return descriptor && !hidden(id) ? descriptor : undefined;
    },
    shutdown: () => manager.shutdown(),
  };
}
