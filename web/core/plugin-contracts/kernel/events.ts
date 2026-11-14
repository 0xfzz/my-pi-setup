/**
 * Event tap registry (PRD §5.5, R14): the read-only subscription seam a
 * server-half plugin uses to consume live session activity.
 *
 * The hook bus is the *host* calling a plugin at a named point. A tap is the
 * opposite direction — a plugin subscribing to traffic the host already has —
 * so it needs its own rules:
 *
 *   - channels are a closed vocabulary, so a subscriber cannot invent traffic
 *     and the host knows exactly which projections it owes;
 *   - a delivery runs under a time budget and an error boundary, and a failure
 *     is counted toward the plugin's breaker instead of reaching the agent
 *     loop;
 *   - delivery order per subscriber is preserved, so a plugin tracking state
 *     sees a tool start before its end even when its own handler is slow.
 *
 * Nothing here reads pi. The host projects one session event into a bounded
 * `TapEvent` (`web/core/server/session-tap.ts`) and publishes it; a channel
 * with no subscriber costs nothing because the caller asks first.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import { runWithBudget } from "./budget.ts";

/**
 * The tap vocabulary. Each channel is a family of pi session events, projected
 * and size-bounded by the host — not a passthrough of the raw event, which can
 * carry megabytes of tool output.
 */
export const TAP_CHANNELS = [
  "session.lifecycle",
  "session.message",
  "session.tool",
] as const;

export type TapChannel = (typeof TAP_CHANNELS)[number];

export const DEFAULT_TAP_BUDGET_MS = 250;

export function isTapChannel(value: string): value is TapChannel {
  return (TAP_CHANNELS as readonly string[]).includes(value);
}

export interface TapEvent {
  channel: TapChannel;
  /** The live session the activity belongs to. */
  sessionId: string;
  /** The project root the session runs in, when known. */
  project?: string;
  /** The pi session event type this was projected from (`tool_execution_end`, …). */
  type: string;
  /** Bounded, plugin-safe payload. Never the raw event. */
  payload: Readonly<Record<string, unknown>>;
}

export type TapHandler = (event: TapEvent) => unknown;

export interface TapFailure {
  pluginId: string;
  channel: TapChannel;
  reason: "timeout" | "error";
  message: string;
}

export interface EventTapOwner {
  pluginId: string;
  grants: readonly Capability[];
}

interface Registration {
  owner: EventTapOwner;
  channel: TapChannel;
  handler: TapHandler;
  /** This subscriber's delivery chain: one publish cannot overtake another. */
  queue: Promise<void>;
}

export interface EventTapOptions {
  budgetMs?: number;
  onFailure?: (failure: TapFailure) => void;
  clock?: () => number;
}

export class EventTapRegistry {
  private readonly byChannel = new Map<TapChannel, Registration[]>();
  private readonly budgetMs: number;
  private onFailure: (failure: TapFailure) => void;
  private readonly clock: () => number;

  constructor(options: EventTapOptions = {}) {
    this.budgetMs = options.budgetMs ?? DEFAULT_TAP_BUDGET_MS;
    this.onFailure = options.onFailure ?? (() => undefined);
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Subscribe to one channel. Throws for an unknown channel or a missing
   * `tap.pi-events:<channel>` grant. Returns the unsubscribe function.
   */
  subscribe(owner: EventTapOwner, channel: string, handler: TapHandler): () => void {
    if (!isTapChannel(channel)) {
      throw new Error(`Plugin "${owner.pluginId}": unknown tap channel "${channel}"`);
    }
    const requested = parseCapability(`tap.pi-events:${channel}`);
    if (!requested.ok) throw new Error(`Plugin "${owner.pluginId}": ${requested.error}`);
    assertGranted(owner.pluginId, owner.grants, requested.value);

    const registration: Registration = {
      owner,
      channel,
      handler,
      queue: Promise.resolve(),
    };
    this.byChannel.set(channel, [...(this.byChannel.get(channel) ?? []), registration]);
    return () => {
      const list = this.byChannel.get(channel) ?? [];
      const kept = list.filter((entry) => entry !== registration);
      if (kept.length === 0) this.byChannel.delete(channel);
      else this.byChannel.set(channel, kept);
    };
  }

  /** Whether anyone listens: the host skips the projection entirely when nobody does. */
  hasSubscribers(channel: TapChannel): boolean {
    return (this.byChannel.get(channel)?.length ?? 0) > 0;
  }

  /**
   * Deliver one event to every subscriber of its channel. Resolves once each
   * handler settled or was abandoned; a failure is reported, never thrown.
   */
  publish(event: TapEvent): Promise<void> {
    const list = this.byChannel.get(event.channel);
    if (list === undefined || list.length === 0) return Promise.resolve();
    // Snapshot: a handler may unsubscribe during its own delivery.
    const deliveries = [...list].map((registration) => {
      registration.queue = registration.queue.then(() => this.invoke(registration, event));
      return registration.queue;
    });
    return Promise.all(deliveries).then(() => undefined);
  }

  /** Set after construction: the manager needs the registry first, and the registry reports to the manager. */
  setFailureHandler(handler: (failure: TapFailure) => void): void {
    this.onFailure = handler;
  }

  /** Remove every subscription a plugin holds (deactivate, rollback, quarantine). */
  removeOwner(pluginId: string): number {
    let removed = 0;
    for (const [channel, list] of this.byChannel) {
      const kept = list.filter((entry) => entry.owner.pluginId !== pluginId);
      removed += list.length - kept.length;
      if (kept.length === 0) this.byChannel.delete(channel);
      else this.byChannel.set(channel, kept);
    }
    return removed;
  }

  private async invoke(registration: Registration, event: TapEvent): Promise<void> {
    const label = `${registration.owner.pluginId} tap ${registration.channel}`;
    const outcome = await runWithBudget(label, this.budgetMs, () => registration.handler(event), this.clock);
    if (outcome.ok) return;
    this.onFailure({
      pluginId: registration.owner.pluginId,
      channel: registration.channel,
      reason: outcome.reason,
      message: outcome.error,
    });
  }
}
