/**
 * Plugin manager (PRD §6). Drives the lifecycle state machine for every discovered
 * plugin: resolve, enable, load, activate, deactivate, reload with rollback,
 * quarantine, and safe mode. It never runs plugin code itself; the loader is
 * injected, so the same logic runs in production (a native dynamic import of
 * the manifest's `main.server`) and in tests (fakes).
 */
import { AuditLog } from "./audit.ts";
import { CircuitBreaker } from "./breaker.ts";
import { engineMismatch } from "./compat.ts";
import { runWithBudget } from "./budget.ts";
import { assertGranted, formatCapability, isSensitive, parseCapability, resolveGrants, type Capability } from "./capabilities.ts";
import type { DiscoveredPlugin } from "./discovery.ts";
import { EventTapRegistry, type TapHandler } from "./events.ts";
import { PluginChannelBus, type PeerHandler } from "./plugin-channels.ts";
import { PluginLifecycle, isLive, type PluginEvent, type PluginState } from "./lifecycle.ts";
import { HookBus } from "./hooks.ts";
import { PluginUiRegistry, type NotificationLevel } from "./plugin-ui.ts";
import { deactivationOrder, requiredDependents, resolvePlugins, type ResolverInput } from "./resolver.ts";
import { PluginRouteRegistry, type PluginRouteHandler } from "./routes.ts";
import { ServiceRegistry } from "./services.ts";
import { PluginStorage, type ScopedStorage } from "./storage.ts";
import type { ChildProcess } from "node:child_process";
import { createProcessRegistry, type ChildSpawnOptions, type PluginProcessRegistry } from "./processes.ts";
import { markActivating, markCleanShutdown, clearSafeMode, recordBoot, recoverInterruptedActivation, setPluginState, type WebPluginsState } from "./state.ts";
import type { WebView } from "../view.ts";

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

/**
 * Realtime communication for this plugin, in all three directions:
 *
 * - `on` — host session traffic (`session.lifecycle`, `session.message`,
 *   `session.tool`). Needs `tap.pi-events:<channel>`.
 * - `listen` — another plugin's channel. Needs `events.subscribe:<channel>`;
 *   your own namespace is free.
 * - `emit` — announce on a channel in your own namespace (`<yourId>.<name>`).
 */
export interface PluginEvents {
  on(channel: string, handler: TapHandler): () => void;
  listen(channel: string, handler: PeerHandler): () => void;
  emit(channel: string, payload: unknown): boolean;
}

/**
 * The plugin's own surface in the browser. Each call lands in the same
 * per-session store a pi extension publishes into, so one screen has one
 * source of truth; the payload is validated there. Needs `ui.publish`.
 */
export interface PluginUi {
  /** Publish this plugin's declared view for a session. */
  view(sessionId: string, view: WebView): boolean;
  /** A transient toast. */
  notify(sessionId: string, message: string, level?: NotificationLevel): boolean;
  /** This plugin's line in the status area; `null` removes it. */
  status(sessionId: string, text: string | null): boolean;
  /** This plugin's widget lines; `null` removes them. */
  widget(sessionId: string, lines: string[] | null, placement?: "aboveEditor" | "belowEditor"): boolean;
}

/**
 * OS resources this plugin owns, with the kernel as the owner of record.
 *
 * A plugin can be reloaded, disabled or quarantined at any moment, so anything
 * that outlives a JS object — a child process, a timer, an abort controller —
 * must not be left to the plugin's own memory. Everything created here is
 * disposed with the plugin, in the same LIFO order as `register`.
 *
 * This is a durability contract, not a sandbox: plugin code runs in-process and
 * could call `child_process` directly. A child spawned outside `spawn` is
 * invisible to the kernel and survives its plugin.
 */
export interface PluginResources {
  /** A child process owned by this plugin. Needs the `exec` grant; never detached. */
  spawn(command: string, args?: readonly string[], options?: ChildSpawnOptions): ChildProcess;
  /** An interval cleared on deactivate. Unref'd, so a leaked one cannot keep the host alive. */
  interval(callback: () => void, everyMs: number): NodeJS.Timeout;
  /** A one-shot timer cleared on deactivate. */
  timeout(callback: () => void, afterMs: number): NodeJS.Timeout;
  /** A controller aborted when the plugin stops — for fetch, streams, and long loops. */
  signal(): AbortController;
  /** Kill this plugin's children now, without waiting for deactivate. */
  release(): Promise<void>;
}

/** HTTP route registration for this plugin's own backend surface. */
export interface PluginRoutes {
  /** `ctx.routes.register("GET", "summary/:id", handler)` mounts /api/p/<pluginId>/summary/<id>. */
  register(method: string, path: string, handler: PluginRouteHandler): () => void;
  get(path: string, handler: PluginRouteHandler): () => void;
  post(path: string, handler: PluginRouteHandler): () => void;
  put(path: string, handler: PluginRouteHandler): () => void;
  patch(path: string, handler: PluginRouteHandler): () => void;
  delete(path: string, handler: PluginRouteHandler): () => void;
}

export interface PluginContext {
  readonly id: string;
  readonly signal: AbortSignal;
  /** Register cleanup. Everything registered is disposed LIFO on deactivate or rollback. */
  register(dispose: PluginDisposer): void;
  /**
   * Owned OS resources: child processes, timers, abort controllers. Disposed
   * with the plugin, so a hot-reload cannot leave one behind.
   */
  readonly resources: PluginResources;
  readonly hooks: PluginHooks;
  /**
   * Read-only subscription to live session activity (`session.lifecycle`,
   * `session.message`, `session.tool`). Delivery is budgeted, isolated, and
   * ordered per subscriber; every subscription is removed on deactivate.
   */
  readonly events: PluginEvents;
  /**
   * This plugin's own browser surface, validated and stored by the host. Every
   * entry is namespaced by the plugin's id and cleared on deactivate.
   */
  readonly ui: PluginUi;
  readonly services: PluginServices;
  /**
   * Mount HTTP routes under `/api/p/<pluginId>/`. Needs the `routes` capability;
   * every route is removed on deactivate and runs under a time budget.
   */
  readonly routes: PluginRoutes;
  /** Scoped storage; each scope needs its `storage:<scope>` grant. Survives deactivation. */
  readonly storage: ScopedStorage;
  /** The plugin's declared settings, from its manifest. Read-only. */
  readonly settings: Readonly<Record<string, unknown>>;
  /** Throws CapabilityError (and audits the denial) unless the capability is granted. */
  assert(capability: string): void;
  log(message: string): void;
}

/**
 * Cleanup registered by a plugin. Its result is awaited, so a disposer that
 * kills a child can wait for the child to be gone; a disposer that returns a
 * plain value (a push, a log) is simply awaited as well.
 */
export type PluginDisposer = () => unknown;

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
  /**
   * Whether this process's start counts toward the crash-loop window. A host that is only
   * evaluated to build (or to prerender) is not a server start, so it passes false. Defaults to true.
   */
  countStarts?: boolean;
  /** Process id recorded for the crash-loop window; defaults to this process. */
  pid?: number;
  budgets?: { activateMs?: number; deactivateMs?: number };
  breaker?: { threshold?: number; windowMs?: number };
  /** Called after every operator-state change; the host writes web-plugins.json here. */
  persist?: (state: WebPluginsState) => void;
  audit?: AuditLog;
  hooks?: HookBus;
  events?: EventTapRegistry;
  channels?: PluginChannelBus;
  ui?: PluginUiRegistry;
  services?: ServiceRegistry;
  routes?: PluginRouteRegistry;
  storage?: PluginStorage;
  /**
   * Owner of record for the child processes plugin code starts. Without it a
   * plugin can still spawn, but nothing reclaims what it leaves behind.
   */
  processes?: PluginProcessRegistry;
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
  disposers: PluginDisposer[];
  /** Built once per activation; its timers and children are disposed with the slot. */
  resources?: PluginResources;
  breaker: CircuitBreaker;
  grants: Capability[];
  pending: Capability[];
  waiting?: string;
  lastError?: string;
  unresolvedReason?: string;
  /**
   * True once the plugin's registrations have been disposed. A registration
   * that arrives afterwards (a timed-out `activate` that kept running) must
   * not become live state for a plugin that is no longer running.
   */
  disposed: boolean;
}

export class PluginManager {
  private readonly slots = new Map<string, Slot>();
  private readonly order: string[] = [];
  private readonly loader: PluginLoader;
  private readonly now: () => number;
  private readonly env: Record<string, string | undefined>;
  private readonly countStarts: boolean;
  private readonly pid: number;
  private readonly activateMs: number;
  private readonly deactivateMs: number;
  private readonly breakerOptions: { threshold: number; windowMs: number };
  private readonly persistFn: (state: WebPluginsState) => void;
  private readonly audit: AuditLog;
  private readonly hooks: HookBus;
  private readonly events: EventTapRegistry;
  private readonly channels: PluginChannelBus;
  private readonly ui: PluginUiRegistry;
  private readonly services: ServiceRegistry;
  private readonly routes: PluginRouteRegistry;
  private readonly storage: PluginStorage;
  private readonly processes: PluginProcessRegistry;
  private state: WebPluginsState;
  private safeMode = false;

  constructor(options: ManagerOptions) {
    this.loader = options.loader;
    this.now = options.now ?? Date.now;
    this.env = options.env ?? {};
    this.countStarts = options.countStarts ?? true;
    this.pid = options.pid ?? process.pid;
    this.activateMs = options.budgets?.activateMs ?? DEFAULT_ACTIVATE_MS;
    this.deactivateMs = options.budgets?.deactivateMs ?? DEFAULT_DEACTIVATE_MS;
    this.breakerOptions = { threshold: options.breaker?.threshold ?? DEFAULT_BREAKER.threshold, windowMs: options.breaker?.windowMs ?? DEFAULT_BREAKER.windowMs };
    this.persistFn = options.persist ?? (() => undefined);
    this.audit = options.audit ?? new AuditLog({ clock: this.now });
    this.hooks = options.hooks ?? new HookBus();
    this.events = options.events ?? new EventTapRegistry();
    this.channels = options.channels ?? new PluginChannelBus();
    this.ui = options.ui ?? new PluginUiRegistry();
    this.services = options.services ?? new ServiceRegistry();
    this.routes = options.routes ?? new PluginRouteRegistry();
    this.storage = options.storage ?? new PluginStorage();
    this.processes = options.processes ?? createProcessRegistry();
    this.hooks.setFailureHandler((failure) => {
      void this.reportFailure(failure.pluginId, `${failure.point} ${failure.reason}: ${failure.message}`);
    });
    // A tap handler that throws or times out is as much a broken plugin as a
    // broken hook, so it counts toward the same breaker.
    this.events.setFailureHandler((failure) => {
      void this.reportFailure(failure.pluginId, `tap ${failure.channel} ${failure.reason}: ${failure.message}`);
    });
    // A listener that cannot keep up is dropping its own backlog, not the
    // emitter's: it is reported, but it is not a failure that trips the breaker.
    this.channels.setFailureHandler((failure) => {
      void this.reportFailure(failure.pluginId, `listen ${failure.channel} ${failure.reason}: ${failure.message}`);
    });
    this.channels.setOverflowHandler((overflow) => {
      this.audit.append("failure", overflow.pluginId, `listen ${overflow.channel} overflow: ${overflow.dropped} event(s) dropped`);
    });
    this.state = options.state;
    for (const plugin of options.plugins) {
      if (this.slots.has(plugin.id)) continue;
      const confirmed = resolveGrants(plugin.manifest.capabilities, {
        inHostTree: plugin.source === "repo",
        confirmed: this.state.plugins[plugin.id]?.grants ?? [],
      });
      this.slots.set(plugin.id, {
        plugin,
        life: new PluginLifecycle(plugin.id, { clock: this.now }),
        disposers: [],
        breaker: new CircuitBreaker({ ...this.breakerOptions, clock: this.now }),
        grants: confirmed.granted,
        pending: confirmed.pending,
        disposed: false,
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
    // Only a real start is recorded; a build worker that evaluates the host must not look like a crash loop.
    const boot = this.countStarts ? recordBoot(this.state, this.now(), this.env, this.pid) : { state: this.state, safeMode: false, reason: undefined };
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
    // A plugin built for another host version is as unresolved as one with a
    // missing dependency: both are named, neither is loaded.
    const unresolved = new Set<string>();
    for (const id of this.order) {
      const slot = this.slots.get(id)!;
      const mismatch = resolution.unresolved[id] ?? engineMismatch(slot.plugin.manifest);
      if (mismatch !== undefined) {
        unresolved.add(id);
        slot.unresolvedReason = mismatch;
        slot.life.dispatch("resolve-fail");
        this.audit.append("rejected", id, mismatch);
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
      if (unresolved.has(id)) continue;
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
    const activated = await this.activateSlot(slot);
    if (activated) await this.hooks.event("plugin.enabled", { id, version: slot.plugin.manifest.version });
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

  /**
   * Confirm one capability the plugin asked for. The grant is persisted, so it
   * survives a restart, and it is audited. A capability the manifest never
   * requested is refused: the operator confirms a request, it cannot widen one.
   *
   * A running plugin picks the grant up for registrations made from now on; a
   * reload re-runs its setup under the new grants.
   */
  grant(id: string, capability: string): ActionResult {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    const parsed = parseCapability(capability);
    if (!parsed.ok) return this.refuse(slot, parsed.error);
    const requested = slot.plugin.manifest.capabilities;
    const match = requested.find((candidate) => formatCapability(candidate) === formatCapability(parsed.value));
    if (match === undefined) {
      return this.refuse(slot, `"${formatCapability(parsed.value)}" is not requested by its manifest`);
    }
    if (!isSensitive(match.kind)) return this.refuse(slot, `"${formatCapability(match)}" is granted automatically`);
    if (isGrantedIn(slot.grants, match)) return this.result(slot);

    slot.grants.push(match);
    removeCapability(slot.pending, match);
    this.setOperator(id, { grants: [...this.state.plugins[id]?.grants ?? [], formatCapability(match)] });
    this.audit.append("granted", id, formatCapability(match));
    return this.result(slot);
  }

  /** Withdraw a capability and put it back in the pending list. */
  revoke(id: string, capability: string): ActionResult {
    const slot = this.slot(id);
    if (!slot) return this.unknown(id);
    const parsed = parseCapability(capability);
    if (!parsed.ok) return this.refuse(slot, parsed.error);
    if (!removeCapability(slot.grants, parsed.value)) {
      return this.refuse(slot, `"${formatCapability(parsed.value)}" is not granted`);
    }
    if (isSensitive(parsed.value.kind) && !isGrantedIn(slot.pending, parsed.value)) {
      slot.pending.push(parsed.value);
    }
    this.setOperator(id, { grants: (this.state.plugins[id]?.grants ?? []).filter((entry) => entry !== formatCapability(parsed.value)) });
    this.audit.append("revoked", id, formatCapability(parsed.value));
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

  /** Whether this plugin is running right now (the only state the web serves). */
  isActive(id: string): boolean {
    const slot = this.slots.get(id);
    return slot !== undefined && isLive(slot.life.state);
  }

  activeIds(): string[] {
    return this.order.filter((id) => isLive(this.slots.get(id)!.life.state));
  }

  isSafeMode(): boolean {
    return this.safeMode;
  }

  /**
   * Leave safe mode deliberately, without waiting for the next restart.
   *
   * The crash-loop guard trips on two starts inside its window, which also
   * catches a dev reload or a supervisor restart — restarts that are not
   * crashes. Until this action existed the only way out was hand-editing the
   * state file, so a stuck host looked like a broken plugin: views still render
   * but every action answers 404. Enabled plugins that safe mode parked are
   * activated here, in dependency order.
   */
  async clearSafeMode(): Promise<{ ok: boolean; activated: string[]; failed: Record<string, string> }> {
    if (!this.safeMode) return { ok: true, activated: [], failed: {} };
    this.safeMode = false;
    this.state = clearSafeMode(this.state);
    this.audit.append("safe-mode", "kernel", "cleared by the operator");
    const activated: string[] = [];
    const failed: Record<string, string> = {};
    for (const id of this.resolvedOrder()) {
      const slot = this.slots.get(id)!;
      if (!this.state.plugins[id]?.enabled || isLive(slot.life.state) || slot.life.state === "quarantined") continue;
      if (slot.unresolvedReason !== undefined) continue;
      slot.waiting = undefined;
      try {
        // The safe-mode branch of start() left these slots parked before the
        // enable transition; activateSlot only runs from `enabled`.
        slot.life.dispatch("enable");
        await this.activateSlot(slot);
        if (isLive(slot.life.state)) activated.push(id);
        else if (slot.lastError !== undefined) failed[id] = slot.lastError;
      } catch (error) {
        failed[id] = error instanceof Error ? error.message : String(error);
      }
    }
    this.save();
    return { ok: true, activated, failed };
  }

  /** Record a hook bail veto in the bounded audit log (PRD R24). */
  recordVeto(pluginId: string, point: string, reason: string): void {
    this.audit.append("veto", pluginId, `${point}: ${reason}`);
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

  /**
   * Run one registration, or refuse it when the plugin is already disposed.
   *
   * A timed-out activation keeps running: `runWithBudget` abandons it, the
   * disposers are drained, and the still-running `activate` may then register a
   * hook, service or route for a plugin that is no longer live. Refusing here is
   * what keeps that leak out of the registries; a refusal is audited, never
   * thrown into the plugin's own code path.
   */
  private track(slot: Slot, register: () => () => void): () => void {
    if (slot.disposed) {
      this.audit.append("failure", slot.plugin.id, "registration after disposal refused");
      return () => {};
    }
    return register();
  }

  private makeContext(slot: Slot, signal: AbortSignal): PluginContext {
    const id = slot.plugin.id;
    const owner = { pluginId: id, grants: slot.grants };
    const scoped = this.storage.forPlugin(owner);
    return {
      id,
      signal,
      register: (dispose) => this.addDisposer(slot, dispose),
      resources: this.resourcesFor(slot),
      hooks: {
        event: (point, handler, priority) => this.track(slot, () => this.hooks.register(owner, "event", point, handler, priority)),
        waterfall: (point, handler, priority) => this.track(slot, () => this.hooks.register(owner, "waterfall", point, handler, priority)),
        bail: (point, handler, priority) => this.track(slot, () => this.hooks.register(owner, "bail", point, handler, priority)),
      },
      events: {
        on: (channel, handler) => this.track(slot, () => this.events.subscribe(owner, channel, handler)),
        listen: (channel, handler) => this.track(slot, () => this.channels.listen(owner, channel, handler)),
        emit: (channel, payload) => {
          if (slot.disposed) return false;
          return this.channels.emit(owner, channel, payload);
        },
      },
      ui: {
        view: (sessionId, view) => this.ui.publishView(owner, sessionId, view),
        notify: (sessionId, message, level) => this.ui.notify(owner, sessionId, message, level),
        status: (sessionId, text) => this.ui.setStatus(owner, sessionId, text),
        widget: (sessionId, lines, placement) => this.ui.setWidget(owner, sessionId, lines, placement),
      },
      services: {
        provide: (name, impl) => this.track(slot, () => this.services.register(owner, name, "provide", impl)),
        replace: (name, impl, priority) => this.track(slot, () => this.services.register(owner, name, "replace", impl, priority)),
        decorate: (name, wrap, priority) => this.track(slot, () => this.services.register(owner, name, "decorate", wrap, priority)),
      },
      routes: {
        register: (method, path, handler) => this.track(slot, () => this.routes.register(owner, method, path, handler)),
        get: (path, handler) => this.track(slot, () => this.routes.register(owner, "GET", path, handler)),
        post: (path, handler) => this.track(slot, () => this.routes.register(owner, "POST", path, handler)),
        put: (path, handler) => this.track(slot, () => this.routes.register(owner, "PUT", path, handler)),
        patch: (path, handler) => this.track(slot, () => this.routes.register(owner, "PATCH", path, handler)),
        delete: (path, handler) => this.track(slot, () => this.routes.register(owner, "DELETE", path, handler)),
      },
      storage: scoped,
      settings: Object.freeze({ ...slot.plugin.manifest.settings }),
      assert: (capability) => {
        const parsed = parseCapability(capability);
        if (!parsed.ok) throw new Error(`Plugin "${id}": ${parsed.error}`);
        this.assertGrant(slot, parsed.value);
      },
      log: (message) => {
        this.audit.append("lifecycle", id, message);
      },
    };
  }

  /**
   * Add a disposer, or run it immediately when the plugin is already disposed.
   *
   * A timed-out activation keeps running: `runWithBudget` abandons it, the
   * disposers are drained, and the still-running `activate` may then register a
   * timer, a child or a route for a plugin that is no longer live. Running the
   * disposer on the spot is what keeps that leak out of the machine; a refusal
   * is audited, never thrown into the plugin's own code path.
   */
  private addDisposer(slot: Slot, dispose: PluginDisposer): void {
    if (!slot.disposed) {
      slot.disposers.push(dispose);
      return;
    }
    this.audit.append("failure", slot.plugin.id, "registration after disposal refused");
    try {
      void dispose();
    } catch (error) {
      this.audit.append("failure", slot.plugin.id, `late dispose threw: ${errorText(error)}`);
    }
  }

  private assertGrant(slot: Slot, capability: Capability): void {
    try {
      assertGranted(slot.plugin.id, slot.grants, capability);
    } catch (error) {
      this.audit.append("capability-denied", slot.plugin.id, formatCapability(capability));
      throw error;
    }
  }

  /**
   * The slot's owned resources. Built once per activation so a timer or child
   * created during `setup` is disposed by the same slot that created it.
   */
  private resourcesFor(slot: Slot): PluginResources {
    if (slot.resources !== undefined) return slot.resources;
    const id = slot.plugin.id;
    const resources: PluginResources = {
      spawn: (command, args = [], options = {}) => {
        // Starting a process is a sensitive capability: it stays pending until
        // the operator grants it, exactly like reaching the network.
        this.assertGrant(slot, { kind: "exec" });
        return this.processes.spawn(id, command, args, options);
      },
      interval: (callback, everyMs) => {
        const timer = setInterval(callback, everyMs);
        // A plugin timer must never be the reason the host cannot exit.
        timer.unref();
        this.addDisposer(slot, () => clearInterval(timer));
        return timer;
      },
      timeout: (callback, afterMs) => {
        const timer = setTimeout(callback, afterMs);
        this.addDisposer(slot, () => clearTimeout(timer));
        return timer;
      },
      signal: () => {
        const controller = new AbortController();
        this.addDisposer(slot, () => controller.abort());
        return controller;
      },
      release: async () => {
        await this.processes.release(id);
      },
    };
    slot.resources = resources;
    return resources;
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

  /**
   * Dispose registrations LIFO, waiting for the ones that need it.
   *
   * Disposers may be async — killing a child and waiting for it to exit is the
   * normal case — so the whole drain runs under the deactivate budget instead
   * of being fire-and-forget. A throwing or overrunning disposer is audited and
   * does not stop the rest.
   */
  private async disposeAll(slot: Slot): Promise<void> {
    slot.disposed = true;
    this.hooks.removeOwner(slot.plugin.id);
    this.events.removeOwner(slot.plugin.id);
    this.channels.removeOwner(slot.plugin.id);
    this.ui.removeOwner(slot.plugin.id);
    this.services.removeOwner(slot.plugin.id);
    this.routes.removeOwner(slot.plugin.id);
    slot.resources = undefined;
    const pending = slot.disposers.splice(0).reverse();
    if (pending.length === 0) return;
    const outcome = await runWithBudget(`${slot.plugin.id} dispose`, this.deactivateMs, async () => {
      for (const dispose of pending) {
        try {
          await dispose();
        } catch (error) {
          this.audit.append("failure", slot.plugin.id, `dispose threw: ${errorText(error)}`);
        }
      }
    });
    if (!outcome.ok) {
      this.audit.append("failure", slot.plugin.id, `dispose ${outcome.reason}: ${outcome.error}`);
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
    slot.disposed = false;
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
      // An abandoned activation may already have spawned a child: nothing else
      // in the failure path would ever release it.
      await this.processes.release(id);
      await this.disposeAll(slot);
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
    // The safety net: whatever this plugin started dies with it, even if it
    // never registered a disposer for it.
    await this.processes.release(id);
    await this.disposeAll(slot);
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

function isGrantedIn(grants: readonly Capability[], capability: Capability): boolean {
  const wanted = formatCapability(capability);
  return grants.some((grant) => formatCapability(grant) === wanted);
}

/** Remove one exact capability; returns whether it was there. */
function removeCapability(list: Capability[], capability: Capability): boolean {
  const wanted = formatCapability(capability);
  const index = list.findIndex((grant) => formatCapability(grant) === wanted);
  if (index < 0) return false;
  list.splice(index, 1);
  return true;
}

/** First-party plugins are named `core.*`; they are the only ones that start in safe mode. */
export function isCorePlugin(id: string): boolean {
  return id.startsWith(CORE_PREFIX);
}
