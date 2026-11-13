/**
 * Plugin lifecycle state machine (PRD §6.1). This module is the only place that
 * says which state may follow which. The manager drives it with events; it never
 * assigns a state directly, so every transition is checked and recorded.
 */

export const PLUGIN_STATES = [
  "discovered",
  "validated",
  "rejected",
  "resolved",
  "unresolved",
  "enabled",
  "disabled",
  "loaded",
  "activating",
  "active",
  "failed",
  "deactivating",
  "disposed",
  "quarantined",
  "ignored",
] as const;

export type PluginState = (typeof PLUGIN_STATES)[number];

export const PLUGIN_EVENTS = [
  "validate-ok",
  "validate-fail",
  "resolve-ok",
  "resolve-fail",
  "enable",
  "disable",
  "load",
  "load-fail",
  "activate",
  "activated",
  "activate-fail",
  "deactivate",
  "disposed",
  "retry",
  "quarantine",
  "clear-quarantine",
  "ignore",
] as const;

export type PluginEvent = (typeof PLUGIN_EVENTS)[number];

type Table = { readonly [S in PluginState]: { readonly [E in PluginEvent]?: PluginState } };

/**
 * Allowed transitions. Anything absent is illegal and rejected with a named error.
 * `load-fail` and `activate-fail` both land in `failed`; the manager decides between
 * `retry` and `quarantine` from the circuit breaker.
 */
export const TRANSITIONS: Table = {
  discovered: { "validate-ok": "validated", "validate-fail": "rejected", ignore: "ignored" },
  validated: { "resolve-ok": "resolved", "resolve-fail": "unresolved" },
  rejected: {},
  ignored: {},
  unresolved: { "resolve-ok": "resolved" },
  // `quarantine` from resolved restores a quarantine persisted by an earlier process.
  resolved: { enable: "enabled", disable: "disabled", quarantine: "quarantined" },
  disabled: { enable: "enabled" },
  enabled: { load: "loaded", "load-fail": "failed", disable: "disabled" },
  loaded: { activate: "activating", disable: "disabled", "load-fail": "failed" },
  activating: { activated: "active", "activate-fail": "failed" },
  active: { deactivate: "deactivating" },
  deactivating: { disposed: "disposed" },
  disposed: { enable: "enabled", quarantine: "quarantined", disable: "disabled" },
  failed: { retry: "enabled", quarantine: "quarantined", disable: "disabled" },
  quarantined: { "clear-quarantine": "enabled", disable: "disabled" },
};

export type TransitionResult = { ok: true; state: PluginState } | { ok: false; error: string };

export function transition(state: PluginState, event: PluginEvent): TransitionResult {
  const next = Object.hasOwn(TRANSITIONS[state], event) ? TRANSITIONS[state][event] : undefined;
  if (next === undefined) {
    return { ok: false, error: `illegal lifecycle event "${event}" in state "${state}"` };
  }
  return { ok: true, state: next };
}

/** Enumerates every legal `(from, event, to)` triple; used by the catalog doc and tests. */
export function legalTransitions(): Array<{ from: PluginState; event: PluginEvent; to: PluginState }> {
  return PLUGIN_STATES.flatMap((from) =>
    PLUGIN_EVENTS.flatMap((event) => {
      const to = Object.hasOwn(TRANSITIONS[from], event) ? TRANSITIONS[from][event] : undefined;
      return to === undefined ? [] : [{ from, event, to }];
    }));
}

/** Only `active` plugins receive events, bridge calls and contributions. */
export function isLive(state: PluginState): boolean {
  return state === "active";
}

/** States in which the plugin's code may still be running and needs deactivation. */
export function holdsResources(state: PluginState): boolean {
  return state === "activating" || state === "active" || state === "deactivating";
}

export interface LifecycleRecord {
  from: PluginState;
  event: PluginEvent;
  to: PluginState;
  at: number;
}

/** A plugin's state plus the transitions that produced it. */
export class PluginLifecycle {
  readonly pluginId: string;
  private current: PluginState;
  private readonly log: LifecycleRecord[] = [];
  private readonly clock: () => number;
  private readonly limit: number;

  constructor(pluginId: string, options: { initial?: PluginState; clock?: () => number; historyLimit?: number } = {}) {
    this.pluginId = pluginId;
    this.current = options.initial ?? "discovered";
    this.clock = options.clock ?? Date.now;
    this.limit = options.historyLimit ?? 200;
  }

  get state(): PluginState {
    return this.current;
  }

  get history(): readonly LifecycleRecord[] {
    return this.log;
  }

  /** Apply an event. Illegal events throw, so a manager bug fails loudly in tests. */
  dispatch(event: PluginEvent): PluginState {
    const result = transition(this.current, event);
    if (!result.ok) {
      throw new Error(`Plugin "${this.pluginId}": ${result.error}`);
    }
    this.log.push({ from: this.current, event, to: result.state, at: this.clock() });
    if (this.log.length > this.limit) this.log.splice(0, this.log.length - this.limit);
    this.current = result.state;
    return this.current;
  }

  /** Non-throwing probe: would `event` be accepted right now? */
  can(event: PluginEvent): boolean {
    return transition(this.current, event).ok;
  }
}
