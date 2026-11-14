/**
 * Host facade: the one object the web server asks about plugins. It discovers
 * candidates, boots the manager, persists operator state, and answers which
 * descriptors may be shown or acted on. A descriptor whose plugin is disabled or
 * quarantined is hidden, and its actions are refused, in the same request.
 */
import { AuditLog } from "./audit.ts";
import { compatCandidates, type DescriptorLike } from "./compat.ts";
import { discoverPlugins, type DiscoveredPlugin, type DiscoveryRoots, type Shadowed } from "./discovery.ts";
import { EventTapRegistry } from "./events.ts";
import { PluginManager, type BootReport, type PluginLoader, type PluginRuntime } from "./manager.ts";
import { HookBus } from "./hooks.ts";
import { PluginUiRegistry } from "./plugin-ui.ts";
import { PluginRouteRegistry } from "./routes.ts";
import { ServiceRegistry } from "./services.ts";
import { PluginStorage } from "./storage.ts";
import { loadStorageSnapshot, saveStorageSnapshot } from "./storage-file.ts";
import { loadState, saveState, type WebPluginsState } from "./state.ts";
import { validatePlugin } from "../descriptor.ts";
import { validateRegistry } from "../registry.ts";

/** Coalesce a burst of storage writes into one file write. */
const STORAGE_SAVE_DEBOUNCE_MS = 250;

export interface PluginHostOptions<D extends DescriptorLike> {
  descriptors: readonly D[];
  /** Directory the descriptors live in; reported as their source location. */
  descriptorDir: string;
  roots?: Pick<DiscoveryRoots, "repo" | "user" | "project" | "packages">;
  statePath: string;
  /** Where plugin storage is persisted; defaults to `<statePath>.storage.json`. */
  storagePath?: string;
  env?: Record<string, string | undefined>;
  /** False when this evaluation is not a server start (see ManagerOptions.countStarts). */
  countStarts?: boolean;
  loader?: PluginLoader;
  now?: () => number;
}

export interface PluginHost<D extends DescriptorLike> {
  readonly manager: PluginManager;
  readonly audit: AuditLog;
  readonly shadowed: readonly Shadowed[];
  /** Logic hooks shared by every plugin; the host calls `waterfall`/`bail` at its call sites. */
  readonly hooks: HookBus;
  /**
   * Live session events. The host publishes the bounded projection of each
   * session event here; a plugin subscribes through `ctx.events`.
   */
  readonly events: EventTapRegistry;
  /** The plugin → browser publish gate. The host attaches its store as the sink. */
  readonly ui: PluginUiRegistry;
  readonly services: ServiceRegistry;
  readonly routes: PluginRouteRegistry;
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
  if (plugin.manifest.main.server) {
    throw new Error(`no loader configured for the server entry of "${plugin.id}"`);
  }
  return {};
};

/**
 * Compile a discovered manifest's `contributes` block into a validated
 * `WebPluginDescriptor`, when the plugin declares web UI surfaces, ui
 * contributions, or actions. Returns undefined for pure logic/service plugins.
 */
function manifestDescriptor<D extends DescriptorLike>(
  plugin: DiscoveredPlugin,
  warnings: string[],
): D | undefined {
  const contributes = plugin.manifest.contributes;
  if (!contributes || typeof contributes !== "object") return undefined;
  const raw = contributes as Record<string, unknown>;
  if (raw.surfaces === undefined && raw.ui === undefined && raw.actions === undefined) {
    return undefined;
  }
  const candidate = {
    id: plugin.id,
    title: typeof raw.title === "string" ? raw.title : plugin.manifest.name,
    extension: typeof raw.extension === "string" ? raw.extension : plugin.id,
    ...(raw.icon !== undefined ? { icon: raw.icon } : {}),
    surfaces: Array.isArray(raw.surfaces) ? raw.surfaces : [],
    ...(raw.ui !== undefined ? { ui: raw.ui } : {}),
    ...(typeof raw.description === "string" ? { description: raw.description } : {}),
    ...(raw.actions !== undefined ? { actions: raw.actions } : {}),
    ...(raw.sessionPanel !== undefined ? { sessionPanel: raw.sessionPanel } : {}),
  };
  const validated = validatePlugin(candidate);
  if (!validated.ok) {
    warnings.push(`contributes (${plugin.source}): ${validated.error}`);
    return undefined;
  }
  return validated.plugin as unknown as D;
}

export function createPluginHost<D extends DescriptorLike>(options: PluginHostOptions<D>): PluginHost<D> {
  const warnings: string[] = [];
  const loaded = loadState(options.statePath);
  if (loaded.warning) warnings.push(loaded.warning);

  // Cross-plugin checks no single descriptor can make: duplicate ids, duplicate
  // page paths, duplicate action ids, two plugins claiming one exclusive
  // replacement. A broken registry is a warning at boot, not a crash.
  warnings.push(...validateRegistry(options.descriptors));

  const discovered = discoverPlugins({
    ...options.roots,
    inline: compatCandidates(options.descriptors, options.descriptorDir),
  });
  warnings.push(...discovered.diagnostics);

  const audit = new AuditLog({ clock: options.now });
  const hooks = new HookBus();
  const events = new EventTapRegistry();
  const ui = new PluginUiRegistry();
  const services = new ServiceRegistry();
  const routes = new PluginRouteRegistry();
  const storage = new PluginStorage({ onChange: () => scheduleStorageSave() });

  // Plugin storage is durable: the snapshot a previous process wrote is loaded
  // before any plugin runs, and every mutation is written back (coalesced).
  const storagePath = options.storagePath ?? `${options.statePath}.storage.json`;
  const persistedStorage = loadStorageSnapshot(storagePath);
  if (persistedStorage.warning) warnings.push(persistedStorage.warning);
  if (persistedStorage.snapshot) storage.restore(persistedStorage.snapshot);

  let storageSaveTimer: ReturnType<typeof setTimeout> | null = null;

  function writeStorageNow(): void {
    if (storageSaveTimer !== null) {
      clearTimeout(storageSaveTimer);
      storageSaveTimer = null;
    }
    try {
      saveStorageSnapshot(storagePath, storage.snapshot());
    } catch (error) {
      warnings.push(`could not write ${storagePath}: ${String(error)}`);
    }
  }

  function scheduleStorageSave(): void {
    if (storageSaveTimer !== null) return;
    storageSaveTimer = setTimeout(writeStorageNow, STORAGE_SAVE_DEBOUNCE_MS);
  }
  const manager = new PluginManager({
    plugins: discovered.selected,
    state: loaded.state,
    loader: options.loader ?? defaultLoader,
    env: options.env ?? {},
    countStarts: options.countStarts,
    now: options.now,
    audit,
    hooks,
    events,
    ui,
    services,
    routes,
    storage,
    persist: (state: WebPluginsState) => {
      try {
        saveState(options.statePath, state);
      } catch (error) {
        warnings.push(`could not write ${options.statePath}: ${String(error)}`);
      }
    },
  });

  const byId = new Map<string, D>(options.descriptors.map((d) => [d.id, d] as const));
  const orderedDescriptors: D[] = [...options.descriptors];
  for (const plugin of discovered.selected) {
    const compiled = manifestDescriptor<D>(plugin, warnings);
    if (compiled === undefined) continue;
    const existingIndex = orderedDescriptors.findIndex((d) => d.id === compiled.id);
    if (existingIndex >= 0) {
      // A higher-precedence manifest (project > user > package > repo) shadows the inline descriptor.
      orderedDescriptors[existingIndex] = compiled;
    } else {
      orderedDescriptors.push(compiled);
    }
    byId.set(compiled.id, compiled);
  }

  // Served only while active. Unenabled user/project plugins stay `resolved`,
  // a failed or quarantined one is not live, and in safe mode only the core
  // plugins that started are active — one rule, no state list to keep in sync.
  const served = (id: string): boolean => manager.isActive(id);

  return {
    manager,
    audit,
    shadowed: discovered.shadowed,
    hooks,
    events,
    ui,
    services,
    routes,
    storage,
    ready: manager.start(),
    warnings,
    visible: () => orderedDescriptors.filter((descriptor) => served(descriptor.id)),
    descriptor: (id) => {
      const descriptor = byId.get(id);
      return descriptor !== undefined && served(id) ? descriptor : undefined;
    },
    // A pending storage write is data a plugin already considers saved, so the
    // debounce is flushed rather than dropped.
    shutdown: async () => {
      await manager.shutdown();
      writeStorageNow();
    },
  };
}
