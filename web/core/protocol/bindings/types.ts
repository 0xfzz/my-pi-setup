/** Transport-neutral binding surface the conformance suite drives. */
import type { BridgeEnvelope } from "../envelope.ts";
import type { BridgeError } from "../errors.ts";
import { BINDING_NAMES, type Hello, type HelloAck } from "../version.ts";

export type BindingName = (typeof BINDING_NAMES)[number];

export type BindingReply<T = BridgeEnvelope> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface BindingOptions {
  readonly name: BindingName;
  readonly sessionId: string;
  readonly cwd: string;
  readonly grantedCapabilities: readonly string[];
  readonly initialCursor?: string;
}

/**
 * A binding owns framing, heartbeats, byte pressure and reconnect. Everything
 * above it sees only envelopes; message schemas never see a route or SSE name.
 */
export interface ProtocolBinding {
  readonly name: BindingName;
  hello(hello: Hello, signal?: AbortSignal): Promise<BindingReply<HelloAck>>;
  invoke(envelope: BridgeEnvelope, signal?: AbortSignal): Promise<BindingReply>;
  /** Snapshot of buffered/replayed events, for resync equivalence checks. */
  events(): readonly BridgeEnvelope[];
  close(): Promise<void>;
}
