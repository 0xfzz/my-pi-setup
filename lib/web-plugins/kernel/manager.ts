/**
 * Plugin manager (PRD §6). Drives the lifecycle state machine for every discovered
 * plugin: resolve, enable, load, activate, deactivate, reload with rollback,
 * quarantine, and safe mode. It never runs plugin code itself; the loader is
 * injected, so the same logic runs in production (jiti) and in tests (fakes).
 */
import { AuditLog } from "./audit.ts";
import { CircuitBreaker } from "./breaker.ts";
import { runWithBudget } from "./budget.ts";
import { assertGranted, autoGrant, formatCapability, parseCapability, type Capability } from "./capabilities.ts";
import type { DiscoveredPlugin } from "./discovery.ts";
import { PluginLifecycle, isLive, type PluginEvent, type PluginState } from "./lifecycle.ts";
import { HookBus } from "./hooks.ts";
import { deactivationOrder, requiredDependents, resolvePlugins, type ResolverInput } from "./resolver.ts";
import { ServiceRegistry } from "./services.ts";
import { PluginStorage, type ScopedStorage } from "./storage.ts";
import { markActivating, markCleanShutdown, recordBoot, recoverInterruptedActivation, setPluginState, type WebPluginsState } from "./state.ts";

/** Hook registration for this plugin. Each call returns an unregister function. */
export interface PluginHooks {
  event(point: string, handler: (payload: unknown) => unknown, priority?: number): () => void;
  waterfall(point: string, handler: (value: unknown, info: unknown) => unknown, priority?: number): () => void;
  bail(point: string, handler: (payload: unknown) => unknown, priority?: number): () => void;
}

/** Service registration for this plugin. Replacements and decorators need their grants. */
export interface PluginServices {
  provide(name: string, impl: (...args: never[]) => unknown): () => void;
  replace(name: string, impl: (...args: never[]) => unknown, priority?: number): () => void;
  decorate(name: string, wrap: (next: (...args: never[]) => unknown) => (...args: never[]) => unknown, priority?: number): () => void;
}

export interface PluginContext {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Register cleanup. Everything registered is disposed LIFO on deactivate or rollback. */
  register(dispose: () => void): void;
  readonly hooks: PluginHooks;
  readonly services: PluginServices;
  /** Scoped storage; each scope needs its `storage:<scope>` grant. Survives deactivation. */
  readonly storage: ScopedStorage;
  /** Throws CapabilityError (and audits the denial) unless the capability is granted. */
  assert(capability: string): void;
  log(message: string): void;
}

/** The server half of a plugin. Every member is optional; a descriptor-only plugin has none. */
export interface PluginRuntime {
  setup?(ctx: PluginContext): void;
  activate?(ctx: PluginContext): unknown;
  deactivate?(ctx: PluginContext): unknown;
}

export type PluginLoader = (plugin: DiscoveredPlugin) => PluginRuntime | Promise<PluginRuntime>;

export const CORE_PREFIX = "core.";
export const DEFAULT_ACTIVATE_MS = 5_000;
export const DEFAULT_DEACTIVATE_MS = 2_000;
export const DEFAULT_BREAKER = { threshold: 3, windowMs: 10 * 60_000 } as const;

export interface ManagerOptions {
  plugins: readonly DiscoveredPlugin[];
  state: WebPluginsState;
  loader: PluginLoader;
  env?: Record<string, string | undefined>;
  now?: () => number;
  /** Process id recorded for the crash-loop window; defaults to this process. */
  pid?: number;
  budgets?: { activateMs?: number; deactivateMs?: number };
  breaker?: { threshold?: number; windowMs?: number };
  /** Called after every operator-state change; the host writes web-plugins.json here. */
  persist?: (state: WebPluginsState) => void;
  audit?: AuditLog;
  hooks?: HookBus;
  services?: ServiceRegistry;
  storage?: PluginStorage;
}

export interface BootReport {
  safeMode: boolean;
  safeModeReason?: string;
  active: string[];
  failed: Record<string, string>;
  crashed: string[];
}

export interface PluginStatus {
  id: string;
  source: DiscoveredPlugin["source"];
  version: string;
  state: PluginState;
  /** Why an enabled plugin is not running yet (dependency missing, safe mode, crash). */
  waiting?: string;
  lastError?: string;
  grants: string[];
  pending: string[];
  quarantine?: { version: string; reason: string; at: number };
}

export type ActionResult = { ok: true; state: PluginState } | { ok: false; state: PluginState; error: string };

interface Slot {
  plugin: DiscoveredPlugin;
  life: PluginLifecycle;
  runtime?: PluginRuntime;
  disposers: Array<() => void>;
  breaker: CircuitBreaker;
  grants: Capability[];
  pending: Capability[];
  waiting?: string;
  lastError?: string;
  unresolvedReason?: string;
}

export class PluginManager {
  private readonly slots = new Map<string, Slot>();
  private readonly order: string[] = [];
  private readonly loader: PluginLoader;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly pid: number;
  private readonly activateMs: number;
  private readonly deactivateMs: number;
  private readonly breakerOptions: { threshold: number; windowMs: number };
  private readonly persistFn: (state: WebPluginsState) => void;
  private readonly audit: AuditLog;
  private readonly hooks: HookBus;
  private readonly services: ServiceRegistry;
  private readonly storage: PluginStorage;
  private state: WebPluginsState;
  private safeMode = false;

  constructor(options: ManagerOptions) {
    this.loader = options.loader;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? {};
    this.pid = options.pid ?? process.pid;
    this.activateMs = options.budgets?.activateMs ?? DEFAULT_ACTIVATE_MS;
    this.deactivateMs = options.budgets?.deactivateMs ?? DEFAULT_DEACTIVATE_MS;
    this.breakerOptions = { threshold: options.breaker?.threshold ?? DEFAULT_BREAKER.threshold, windowMs: options.breaker?.windowMs ?? DEFAULT_BREAKER.windowMs };
    this.persistFn = options.persist ?? (() => undefined);
    this.audit = options.audit ?? new AuditLog({ clock: this.now });
    this.hooks = options.hooks ?? new HookBus();
    this.services = options.services ?? new ServiceRegistry();
    this.storage = options.storage ?? new PluginStorage();
    this.hooks.setFailureHandler((failure) => {
      void this.reportFailure(failure.pluginId, `${failure.point} ${failure.reason}: ${failure.message}`);
    });
    this.state = options.state;
    for (const plugin of options.plugins) {
      if (this.slots.has(plugin.id)) continue;
      const auto = autoGrant(plugin.manifest.capabilities);
      this.slots.set(plugin.id, {
        plugin,
        life: new PluginLifecycle(plugin.id, { clock: this.now }),
        disposers: [],
        breaker: new CircuitBreaker({ ...this.breakerOptions, clock: this.now }),
        grants: auto.granted,
        pending: auto.pending,
      });
      this.order.push(plugin.id);
    }
    this.order.sort();
  }

  /** The operator state as it stands; persisted by the host. */
  get operatorState(): WebPluginsState {
    return this.state;
  }

  /** Boot: safe-mode decision, crash recovery, resolution, then activation in dependency order. */
  async start(): Promise<BootReport> {
    const boot = recordBoot(this.state, this.now(), this.env, this.pid);
    this.safeMode = boot.safeMode;
    this.state = boot.state;
    if (boot.safeMode) this.audit.append("safe-mode", "kernel", boot.reason ?? "safe mode");

    const recovered = recoverInterruptedActivation(this.state);
    this.state = recovered.state;

    for (const plugin of this.order) {
      const slot = this.slots.get(plugin)!;
      slot.life.dispatch("validate-ok");
      this.audit.append("discovered", plugin, `${slot.plugin.source} ${slot.plugin.dir}`);
    }
    const resolution = resolvePlugins(this.order.map((id) => this.resolverInput(this.slots.get(id)!)));
    for (const id of this.order) {
      const slot = this.slots.get(id)!;
      if (resolution.unresolved[id]) {
        slot.unresolvedReason = resolution.unresolved[id];
        slot.life.dispatch("resolve-fail");
        this.audit.append("rejected", id, slot.unresolvedReason);
      } else {
        slot.life.dispatch("resolve-ok");
      }
    }

    const report: BootReport = { safeMode: boot.safeMode, ...(boot.reason ? { safeModeReason: boot.reason } : {}), active: [], failed: {}, crashed: recovered.crashed };
    // Repo-source plugins (first-party descriptors) default to on so existing behaviour is kept;
    // user, project and package plugins are off until the operator enables them.
    for (const id of this.order) {
      const slot = this.slots.get(id)!;
      if (!this.state.plugins[id] && slot.plugin.source === "repo") {
        this.state = setPluginState(this.state, id, { enabled: true });
      }
    }
    for (const id of resolution.ordered) {
      const slot = this.slots.get(id)!;
      const persisted = this.state.plugins[id];
      if (persisted?.quarantine) {
        if (persisted.quarantine.version === slot.plugin.manifest.version) {
          slot.life.dispatch("quarantine");
          slot.lastError = persisted.quarantine.reason;
          continue;
        }
        this.clearPersistedQuarantine(id, "plugin version changed");
      }
      if (!persisted?.enabled) {
        // Switched off by the operator: record it, so it stays hidden across restarts.
        if (persisted && slot.life.can("disable")) slot.life.dispatch("disable");
        continue;
      }
      if (recovered.crashed.includes(id)) {
        slot.life.dispatch("enable");
        slot.waiting = "crashed while activating on the previous start; enable it to retry";
        this.audit.append("failure", id, slot.waiting);
        continue;
      }
      if (boot.safeMode && !isCorePlugin(id)) {
        slot.waiting = "safe mode: only core plugins start automatically";
        continue;
      }
      slot.life.dispatch("enable");
      await this.activateSlot(slot);
    }
    for (const id of this.order) {
      const slot = this.slots.get(id)!;
      if (isLive(slot.life.state)) report.active.push(id);
      else if (slot.lastError && slot.life.state === "failed") report.failed[id] = slot.lastError;
    }
    this.save();
    return report;
  }

  async enable(id: string): Promise<ActionResult> {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    if (slot.life.state === "quarantined") {
      return this.refuse(slot, "quarantined; clear the quarantine first");
    }
    if (slot.life.state === "unresolved" || slot.life.state === "rejected") {
      return this.refuse(slot, slot.unresolvedReason ?? "not resolvable");
    }
    if (slot.life.state === "failed") slot.life.dispatch("retry");
    else if (slot.life.state !== "enabled") slot.life.dispatch("enable");
    this.setOperator(id, { enabled: true });
    this.audit.append("enabled", id, "operator enabled");
    await this.activateSlot(slot);
    return this.result(slot);
  }

  async disable(id: string): Promise<ActionResult> {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    // Dependents that are running lose their dependency first, in reverse order.
    const dependents = requiredDependents(id, this.order.map((p) => this.resolverInput(this.slots.get(p)!)));
    for (const dependent of dependents.reverse()) {
      const dep = this.slots.get(dependent);
      if (dep && isLive(dep.life.state)) {
        await this.deactivateSlot(dep, `required dependency "${id}" disabled`);
        dep.waiting = `waiting for dependency "${id}"`;
      }
    }
    if (isLive(slot.life.state)) await this.deactivateSlot(slot, "disabled");
    if (slot.life.can("disable")) slot.life.dispatch("disable");
    slot.waiting = undefined;
    this.setOperator(id, { enabled: false });
    this.audit.append("disabled", id, "operator disabled");
    return this.result(slot);
  }

  /**
   * Reload: deactivate, load a fresh runtime, activate. If the new runtime fails
   * to load or activate, the previous working runtime is re-activated and the
   * failure is reported.
   */
  async reload(id: string): Promise<ActionResult & { rolledBack?: boolean }> {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    if (!isLive(slot.life.state)) return { ok: false, state: slot.life.state, error: `cannot reload a ${slot.life.state} plugin`, rolledBack: false };
    const previous = slot.runtime;
    await this.deactivateSlot(slot, "reload");
    slot.life.dispatch("enable");
    let next: PluginRuntime;
    try {
      next = await this.loader(slot.plugin);
    } catch (error) {
      this.fail(slot, `load failed: ${errorText(error)}`, true, "load-fail");
      return this.rollbackReload(slot, previous, slot.lastError ?? "load failed");
    }
    const ok = await this.activateSlot(slot, next, { countFailure: true });
    if (!ok) return this.rollbackReload(slot, previous, slot.lastError ?? "activation failed");
    this.audit.append("lifecycle", id, "reloaded");
    return { ok: true, state: slot.life.state, rolledBack: false };
  }

  /** Clears a quarantine and the breaker window, then tries to activate again. */
  async clearQuarantine(id: string): Promise<ActionResult> {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    if (slot.life.state !== "quarantined") return this.refuse(slot, "not quarantined");
    this.clearPersistedQuarantine(id, "operator cleared quarantine");
    slot.breaker.reset();
    slot.lastError = undefined;
    slot.life.dispatch("clear-quarantine");
    this.setOperator(id, { enabled: true, quarantineClearedAt: this.now() });
    await this.activateSlot(slot);
    return this.result(slot);
  }

  /** Read-only view for the inspector and the plugin manager. */
  snapshot(): PluginStatus[] {
    return this.order.map((id) => {
      const slot = this.slots.get(id)!;
      const persisted = this.state.plugins[id];
      return {
        id,
        source: slot.plugin.source,
        version: slot.plugin.manifest.version,
        state: slot.life.state,
        ...(slot.waiting ? { waiting: slot.waiting } : {}),
        ...(slot.lastError ?? slot.unresolvedReason ? { lastError: slot.lastError ?? slot.unresolvedReason } : {}),
        grants: slot.grants.map(formatCapability),
        pending: slot.pending.map(formatCapability),
        ...(persisted?.quarantine ? { quarantine: persisted.quarantine } : {}),
      };
    });
  }

  activeIds(): string[] {
    return this.order.filter((id) => isLive(this.slots.get(id)!.life.state));
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  /** Shut everything down: deactivate in reverse dependency order, then flush state. */
  async shutdown(): Promise<void> {
    const live = this.activeIds();
    const reverse = deactivationOrder(this.resolvedOrder());
    for (const id of reverse) {
      if (live.includes(id)) await this.deactivateSlot(this.slots.get(id)!, "shutdown");
    }
    this.state = markCleanShutdown(this.state);
    this.save();
  }

  private resolvedOrder(): string[] {
    return resolvePlugins(this.order.map((id) => this.resolverInput(this.slots.get(id)!))).ordered;
  }

  private resolverInput(slot: Slot): ResolverInput {
    return {
      id: slot.plugin.id,
      version: slot.plugin.manifest.version,
      dependsOn: slot.plugin.manifest.dependsOn,
      optionalDependsOn: slot.plugin.manifest.optionalDependsOn,
    };
  }

  private slot(id: string): Slot | undefined {
    return this.slots.get(id);
  }

  private unknown(id: string): ActionResult {
    return { ok: false, state: "discovered", error: `unknown plugin "${id}"` };
  }

  private refuse(slot: Slot, error: string): ActionResult {
    return { ok: false, state: slot.life.state, error: `Plugin "${slot.plugin.id}": ${error}` };
  }

  private result(slot: Slot): ActionResult {
    return slot.lastError && slot.life.state !== "active"
      ? { ok: false, state: slot.life.state, error: slot.lastError }
      : { ok: true, state: slot.life.state };
  }

  private setOperator(id: string, patch: Partial<WebPluginsState["plugins"][string]>): void {
    this.state = setPluginState(this.state, id, patch);
    this.save();
  }

  private clearPersistedQuarantine(id: string, why: string): void {
    const current = this.state.plugins[id];
    if (!current?.quarantine) return;
    const { quarantine: _dropped, ...rest } = current;
    this.state = { ...this.state, plugins: { ...this.state.plugins, [id]: rest } };
    this.audit.append("quarantine-cleared", id, why);
    this.save();
  }

  private save(): void {
    this.persistFn(this.state);
  }

  private makeContext(slot: Slot, signal: AbortSignal): PluginContext {
    const id = slot.plugin.id;
    const owner = { pluginId: id, grants: slot.grants };
    const scoped = this.storage.forPlugin(owner);
    return {
      id,
      signal,
      register: (dispose) => {
        slot.disposers.push(dispose);
      },
      hooks: {
        event: (point, handler, priority) => this.hooks.register(owner, "event", point, handler, priority),
        waterfall: (point, handler, priority) => this.hooks.register(owner, "waterfall", point, handler, priority),
        bail: (point, handler, priority) => this.hooks.register(owner, "bail", point, handler, priority),
      },
      services: {
        provide: (name, impl) => this.services.register(owner, name, "provide", impl),
        replace: (name, impl, priority) => this.services.register(owner, name, "replace", impl, priority),
        decorate: (name, wrap, priority) => this.services.register(owner, name, "decorate", wrap, priority),
      },
      storage: scoped,
      assert: (capability) => {
        const parsed = parseCapability(capability);
        if (!parsed.ok) throw new Error(`Plugin "${id}": ${parsed.error}`);
        try {
          assertGranted(id, slot.grants, parsed.value);
        } catch (error) {
          this.audit.append("capability-denied", id, capability);
          throw error;
        }
      },
      log: (message) => {
        this.audit.append("lifecycle", id, message);
      },
    };
  }

  /**
   * Hook failures count toward the breaker. A trip deactivates a running plugin and
   * quarantines it, so a plugin that keeps breaking a hook stops being called.
   */
  async reportFailure(pluginId: string, reason: string): Promise<void> {
    const slot = this.slots.get(pluginId);
    if (!slot) return;
    this.audit.append("failure", pluginId, reason);
    if (!slot.breaker.recordFailure()) return;
    if (isLive(slot.life.state)) await this.deactivateSlot(slot, "circuit breaker tripped");
    if (slot.life.can("quarantine")) {
      this.quarantine(slot, `hook failures tripped the breaker; last: ${reason}`);
    }
  }

  /** Dispose registrations LIFO. A throwing disposer is audited and does not stop the rest. */
  private disposeAll(slot: Slot): void {
    this.hooks.removeOwner(slot.plugin.id);
    this.services.removeOwner(slot.plugin.id);
    while (slot.disposers.length) {
      const dispose = slot.disposers.pop()!;
      try {
        dispose();
      } catch (error) {
        this.audit.append("failure", slot.plugin.id, `dispose threw: ${errorText(error)}`);
      }
    }
  }

  /** Requires dependencies to be running; a plugin is never activated on top of a missing one. */
  private missingDependency(slot: Slot): string | undefined {
    for (const dep of Object.keys(slot.plugin.manifest.dependsOn)) {
      const depSlot = this.slots.get(dep);
      if (!depSlot || !isLive(depSlot.life.state)) return dep;
    }
    return undefined;
  }

  private async activateSlot(slot: Slot, given?: PluginRuntime, options: { countFailure?: boolean } = {}): Promise<boolean> {
    const id = slot.plugin.id;
    if (slot.life.state !== "enabled") return false;
    const missing = this.missingDependency(slot);
    if (missing) {
      slot.waiting = `waiting for dependency "${missing}"`;
      return false;
    }
    slot.waiting = undefined;

    if (given === undefined) {
      try {
        // A plugin without a server entry is declarative: there is no code to load.
        slot.runtime = slot.plugin.manifest.main.server ? await this.loader(slot.plugin) : {};
      } catch (error) {
        return this.fail(slot, `load failed: ${errorText(error)}`, options.countFailure ?? true, "load-fail");
      }
    } else {
      slot.runtime = given;
    }
    const runtime = slot.runtime!;
    slot.life.dispatch("load");
    slot.life.dispatch("activate");
    this.state = markActivating(this.state, [...(this.state.activating), id]);
    this.save();

    const outcome = await runWithBudget(`${id} activate`, this.activateMs, async (signal) => {
      const ctx = this.makeContext(slot, signal);
      runtime.setup?.(ctx);
      await runtime.activate?.(ctx);
    });

    this.state = markActivating(this.state, this.state.activating.filter((other) => other !== id));
    this.save();
    if (!outcome.ok) {
      this.disposeAll(slot);
      const reason = outcome.reason === "timeout" ? outcome.error : `activate threw: ${outcome.error}`;
      return this.fail(slot, reason, options.countFailure ?? true, "activate-fail");
    }
    slot.life.dispatch("activated");
    slot.lastError = undefined;
    this.audit.append("lifecycle", id, `active (${slot.grants.length} grant(s), ${slot.pending.length} pending)`);
    return true;
  }

  private fail(slot: Slot, reason: string, countFailure: boolean, event: PluginEvent): boolean {
    const id = slot.plugin.id;
    slot.lastError = reason;
    slot.life.dispatch(event);
    this.audit.append("failure", id, reason);
    if (countFailure && slot.breaker.recordFailure()) {
      this.quarantine(slot, `${this.breakerOptions.threshold} failures within ${Math.round(this.breakerOptions.windowMs / 1000)}s; last: ${reason}`);
    }
    return false;
  }

  private quarantine(slot: Slot, reason: string): void {
    const id = slot.plugin.id;
    slot.life.dispatch("quarantine");
    slot.lastError = reason;
    this.state = setPluginState(this.state, id, { quarantine: { version: slot.plugin.manifest.version, reason, at: this.now() } });
    this.audit.append("quarantined", id, reason);
    this.save();
  }

  private async deactivateSlot(slot: Slot, why: string): Promise<void> {
    const id = slot.plugin.id;
    slot.life.dispatch("deactivate");
    const runtime = slot.runtime;
    if (runtime?.deactivate) {
      const outcome = await runWithBudget(`${id} deactivate`, this.deactivateMs, async (signal) => {
        await runtime.deactivate?.(this.makeContext(slot, signal));
      });
      if (!outcome.ok) this.audit.append("failure", id, `deactivate ${outcome.reason}: ${outcome.error}`);
    }
    this.disposeAll(slot);
    slot.life.dispatch("disposed");
    this.audit.append("lifecycle", id, `deactivated (${why})`);
  }

  private async rollbackReload(slot: Slot, previous: PluginRuntime | undefined, reason: string): Promise<ActionResult & { rolledBack: boolean }> {
    const id = slot.plugin.id;
    this.audit.append("failure", id, `reload rolled back: ${reason}`);
    if (previous && slot.life.state === "failed") {
      // The failed attempt is over; re-enable and bring the previous runtime back.
      slot.life.dispatch("retry");
      const restored = await this.activateSlot(slot, previous);
      if (restored) {
        slot.lastError = reason;
        return { ok: false, state: slot.life.state, error: `reload failed (${reason}); previous version restored`, rolledBack: true };
      }
    }
    return { ok: false, state: slot.life.state, error: `reload failed (${reason})`, rolledBack: false };
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** First-party plugins are named `core.*`; they are the only ones that start in safe mode. */
export function isCorePlugin(id: string): boolean {
  return id.startsWith(CORE_PREFIX);
}
