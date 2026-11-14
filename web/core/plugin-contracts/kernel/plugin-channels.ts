/**
 * Plugin-to-plugin channels: the third realtime direction, after the host tap
 * (`events.ts`) and the browser publish (`plugin-ui.ts`).
 *
 * A plugin may announce something on a channel in its **own** namespace
 * (`acme.indexer.done`) and another plugin may listen to it. Three rules make
 * that safe to run inside one process:
 *
 *   - **The namespace is the identity.** A plugin can only emit under its own
 *     id prefix, so a subscriber always knows who produced a payload and no
 *     plugin can forge another's traffic. Listening to someone else's channel
 *     is a read of their data, so it needs `events.subscribe:<channel>`; your
 *     own channel needs nothing, exactly like a hook in your own namespace.
 *   - **Payloads are bounded and inert.** Finite JSON only, capped in size and
 *     nesting, with prototype-polluting keys refused. Nothing is executed and
 *     nothing is re-rendered as HTML.
 *   - **Delivery cannot take the emitter down.** Each listener has its own
 *     ordered queue with a depth cap; a slow listener drops its own backlog
 *     instead of growing memory, and a throwing or slow handler is audited and
 *     counted toward the breaker like any other plugin failure.
 *
 * There is no replay and no retention: a channel is live traffic. A listener
 * that attaches late starts from the next event, which is why a producer that
 * also wants convergence publishes a view (or answers a sync request) instead
 * of replaying history.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import { runWithBudget } from "./budget.ts";
import { isTapChannel } from "./events.ts";

/** Cap on a peer payload, in serialized bytes. */
export const PEER_PAYLOAD_MAX_BYTES = 32 * 1024;
/** Cap on payload nesting, so a cyclic or adversarial shape cannot recurse. */
export const PEER_PAYLOAD_MAX_DEPTH = 8;
/** Cap on listeners per channel: one plugin cannot exhaust the bus. */
export const MAX_LISTENERS_PER_CHANNEL = 64;
/** Cap on a listener's undelivered backlog; beyond it, its own events drop. */
export const MAX_PENDING_PER_LISTENER = 64;
export const DEFAULT_PEER_BUDGET_MS = 250;

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const CHANNEL_SUFFIX = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;

export interface PeerOwner {
  pluginId: string;
  grants: readonly Capability[];
}

/** One plugin's announcement: who sent it, on which channel, with what. */
export interface PeerEvent {
  channel: string;
  /** The emitting plugin's id. Always the channel's namespace. */
  from: string;
  payload: unknown;
}

export type PeerHandler = (event: PeerEvent) => unknown;

export interface PeerFailure {
  pluginId: string;
  channel: string;
  reason: "timeout" | "error";
  message: string;
}

/** A listener that could not keep up. Reported, never counted toward the breaker. */
export interface PeerOverflow {
  pluginId: string;
  channel: string;
  dropped: number;
}

export type PeerPayloadResult = { ok: true; value: unknown } | { ok: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Copy finite JSON, refusing unsafe keys and deep nesting. */
function copyBounded(value: unknown, depth: number): unknown {
  if (depth > PEER_PAYLOAD_MAX_DEPTH) throw new Error(`payload nesting exceeds ${PEER_PAYLOAD_MAX_DEPTH}`);
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("payload numbers must be finite");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => copyBounded(entry, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error(`payload key "${key}" is not allowed`);
      if (entry !== undefined) out[key] = copyBounded(entry, depth + 1);
    }
    return out;
  }
  throw new Error("payload must be finite JSON data");
}

/** Validate and copy one peer payload. Never throws; a refusal names the reason. */
export function boundedPeerPayload(input: unknown): PeerPayloadResult {
  try {
    const serialized = JSON.stringify(input ?? null);
    if (serialized === undefined) return { ok: false, error: "payload must be JSON-serializable" };
    if (Buffer.byteLength(serialized, "utf8") > PEER_PAYLOAD_MAX_BYTES) {
      return { ok: false, error: `payload exceeds ${PEER_PAYLOAD_MAX_BYTES} bytes` };
    }
    return { ok: true, value: copyBounded(input ?? null, 0) };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "invalid payload" };
  }
}

/** Whether `channel` sits in `pluginId`'s namespace (`acme.indexer.done`). */
export function isOwnChannel(pluginId: string, channel: string): boolean {
  return channel.startsWith(`${pluginId}.`)
    && channel.length <= 160
    && CHANNEL_SUFFIX.test(channel.slice(pluginId.length + 1));
}

interface Listener {
  owner: PeerOwner;
  channel: string;
  handler: PeerHandler;
  queue: Promise<void>;
  pending: number;
  dropped: number;
}

export interface PluginChannelOptions {
  budgetMs?: number;
  onFailure?: (failure: PeerFailure) => void;
  onOverflow?: (overflow: PeerOverflow) => void;
  clock?: () => number;
}

export class PluginChannelBus {
  private readonly byChannel = new Map<string, Listener[]>();
  private readonly budgetMs: number;
  private onFailure: (failure: PeerFailure) => void;
  private onOverflow: (overflow: PeerOverflow) => void;
  private readonly clock: () => number;

  constructor(options: PluginChannelOptions = {}) {
    this.budgetMs = options.budgetMs ?? DEFAULT_PEER_BUDGET_MS;
    this.onFailure = options.onFailure ?? (() => undefined);
    this.onOverflow = options.onOverflow ?? (() => undefined);
    this.clock = options.clock ?? Date.now;
  }

  /**
   * Listen to `channel`. Your own namespace needs no grant; another plugin's
   * needs `events.subscribe:<channel>`. Returns the unsubscribe function.
   */
  listen(owner: PeerOwner, channel: string, handler: PeerHandler): () => void {
    if (isTapChannel(channel)) {
      throw new Error(`Plugin "${owner.pluginId}": "${channel}" is host session traffic; use ctx.events.on`);
    }
    if (!isOwnChannel(owner.pluginId, channel)) {
      const requested = parseCapability(`events.subscribe:${channel}`);
      if (!requested.ok) throw new Error(`Plugin "${owner.pluginId}": ${requested.error}`);
      assertGranted(owner.pluginId, owner.grants, requested.value);
    }
    const list = this.byChannel.get(channel) ?? [];
    if (list.length >= MAX_LISTENERS_PER_CHANNEL) {
      throw new Error(`Plugin "${owner.pluginId}": channel "${channel}" already has ${MAX_LISTENERS_PER_CHANNEL} listeners`);
    }
    const listener: Listener = { owner, channel, handler, queue: Promise.resolve(), pending: 0, dropped: 0 };
    this.byChannel.set(channel, [...list, listener]);
    return () => {
      const current = this.byChannel.get(channel) ?? [];
      const kept = current.filter((entry) => entry !== listener);
      if (kept.length === 0) this.byChannel.delete(channel);
      else this.byChannel.set(channel, kept);
    };
  }

  /**
   * Announce something on `channel`, which must sit in the emitter's own
   * namespace. Returns false (with no side effect) for a bad channel or an
   * invalid payload.
   */
  emit(owner: PeerOwner, channel: string, payload: unknown): boolean {
    if (!isOwnChannel(owner.pluginId, channel)) return false;
    const bounded = boundedPeerPayload(payload);
    if (!bounded.ok) return false;
    const listeners = this.byChannel.get(channel);
    if (listeners === undefined || listeners.length === 0) return true;
    const event: PeerEvent = { channel, from: owner.pluginId, payload: bounded.value };
    // Enqueue is synchronous: a listener cannot unsubscribe mid-loop.
    for (const listener of listeners) this.enqueue(listener, event);
    return true;
  }

  /** Whether anyone listens, so an expensive payload can be built lazily. */
  hasListeners(channel: string): boolean {
    return (this.byChannel.get(channel)?.length ?? 0) > 0;
  }

  setFailureHandler(handler: (failure: PeerFailure) => void): void {
    this.onFailure = handler;
  }

  setOverflowHandler(handler: (overflow: PeerOverflow) => void): void {
    this.onOverflow = handler;
  }

  /** Remove every listener a plugin holds (deactivate, rollback, quarantine). */
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

  /**
   * Queue one delivery for one listener, preserving that listener's order. A
   * backlog past the cap drops this event for this listener only: a consumer
   * that cannot keep up must not become the emitter's memory leak.
   */
  private enqueue(listener: Listener, event: PeerEvent): void {
    if (listener.pending >= MAX_PENDING_PER_LISTENER) {
      listener.dropped++;
      this.onOverflow({ pluginId: listener.owner.pluginId, channel: listener.channel, dropped: listener.dropped });
      return;
    }
    listener.pending++;
    listener.queue = listener.queue
      .then(() => this.invoke(listener, event))
      .finally(() => {
        listener.pending--;
      });
  }

  private async invoke(listener: Listener, event: PeerEvent): Promise<void> {
    const label = `${listener.owner.pluginId} listen ${listener.channel}`;
    const outcome = await runWithBudget(label, this.budgetMs, () => listener.handler(event), this.clock);
    if (outcome.ok) return;
    this.onFailure({
      pluginId: listener.owner.pluginId,
      channel: listener.channel,
      reason: outcome.reason,
      message: outcome.error,
    });
  }
}

