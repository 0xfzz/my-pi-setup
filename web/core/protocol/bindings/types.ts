/** Transport-neutral binding surface the conformance suite drives. */
import type { BridgeEnvelope } from "../envelope.ts";
import type { BridgeError } from "../errors.ts";
import { BINDING_NAMES, type Hello, type HelloAck } from "../version.ts";

export type BindingName = (typeof BINDING_NAMES)[number];

export type BindingReply<T = BridgeEnvelope> = { ok: true; value: T } | { ok: false; error: BridgeError };

/** A denial is an auditable event, never a dropped message. */
export interface CapabilityAuditEntry {
  readonly source: string;
  readonly capability: string;
  readonly message: string;
}

export interface BindingOptions {
  readonly name: BindingName;
  /** Omitted for directory-level bindings, which never select a session. */
  readonly sessionId?: string;
  readonly cwd: string;
  readonly grantedCapabilities: readonly string[];
  /** Separate grants for extension/plugin sources; empty unless the host says otherwise. */
  readonly pluginGrants?: readonly string[];
  /** Core messages declared by discovered plugin manifests; keyed by plugin id. */
  readonly bridgeSlices?: ReadonlyMap<string, readonly string[]>;
  readonly initialCursor?: string;
  /** Host-owned sink: every CAPABILITY_DENIED is reported here. */
  readonly audit?: (entry: CapabilityAuditEntry) => void;
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
