/** Envelope-level rules shared by every binding, independent of transport. */
import { Value } from "typebox/value";

import { BRIDGE_MESSAGE_DENIED, bridgeMessageDenied, FIRST_PARTY_BRIDGE_CLIENT, resolveMessage } from "../index.ts";
import type { MessageDefinition } from "../catalog.ts";
import type { BridgeEnvelope } from "../envelope.ts";
import { bridgeError, type BridgeError } from "../errors.ts";
import {
  isGranted,
  parseCapability,
  type Capability,
} from "../../plugin-contracts/kernel/capabilities.ts";
import {
  BINDING_NAMES,
  BRIDGE_PROTOCOL_VERSION,
  HelloSchema,
  versionMismatch,
  type Hello,
  type HelloAck,
} from "../version.ts";
import type { BindingName, BindingOptions, BindingReply, CapabilityAuditEntry } from "./types.ts";

export type BindingTransport = "in-process" | "session-attach" | "http-sse";

/** The host-owned result of a successful hello. Grants are never client-supplied. */
export interface Handshake extends HelloAck {
  readonly clientId: string;
  readonly grants: readonly Capability[];
  readonly pluginGrants: readonly Capability[];
  readonly coreSlices?: ReadonlyMap<string, readonly string[]>;
  readonly messageRegistry?: BindingOptions["messageRegistry"];
}

function parseGrants(capabilities: readonly string[]): readonly Capability[] {
  return capabilities.flatMap((entry) => {
    const parsed = parseCapability(entry);
    return parsed.ok ? [parsed.value] : [];
  });
}

/** The grant grammar's globs (`protocol.invoke:*`) decide coverage, not string equality. */
export function isGrantedCapability(grants: readonly Capability[], requested: Capability): boolean {
  return isGranted(grants, requested);
}

export function handshakeFor(hello: Hello, options: BindingOptions): BindingReply<Handshake> {
  if (!Value.Check(HelloSchema, hello)) {
    return { ok: false, error: bridgeError("VALIDATION_FAILED", "bridge.hello does not match the handshake schema") };
  }
  if (hello.version !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, error: versionMismatch(hello.version) };
  }
  if (!hello.bindings.includes(options.name as BindingName)) {
    return { ok: false, error: bridgeError("UNSUPPORTED_BINDING", `binding "${options.name}" is not supported by the client`) };
  }
  const grants = parseGrants(options.grantedCapabilities);
  const capabilities = hello.capabilities.filter((requested) => {
    const parsed = parseCapability(requested);
    return parsed.ok && isGrantedCapability(grants, parsed.value);
  });
  const state: Handshake = {
    version: BRIDGE_PROTOCOL_VERSION,
    capabilities,
    bindings: [...BINDING_NAMES],
    sessionId: options.sessionId,
    cursor: options.initialCursor ?? "0",
    clientId: hello.clientId,
    grants,
    pluginGrants: parseGrants(options.pluginGrants ?? []),
    ...(options.bridgeSlices === undefined ? {} : { coreSlices: options.bridgeSlices }),
    ...(options.messageRegistry === undefined ? {} : { messageRegistry: options.messageRegistry }),
  };
  return { ok: true, value: state };
}

/** Retained for callers that only need the public ack object. */
export function helloAck(hello: Hello, options: BindingOptions): BindingReply<HelloAck> {
  const handshake = handshakeFor(hello, options);
  if (!handshake.ok) return handshake;
  const { version, capabilities, bindings, sessionId, cursor } = handshake.value;
  return { ok: true, value: { version, capabilities, bindings, sessionId, cursor } };
}

/**
 * Only the host labels a message's origin. A browser transport that claims a
 * core/host identity is relabelled so it cannot bypass the capability gate.
 */
export function attributedSource(
  envelope: BridgeEnvelope,
  handshake: Handshake,
  transport: BindingTransport,
): BridgeEnvelope {
  if (transport !== "http-sse") return envelope;
  if (envelope.source.type !== "core" && envelope.source.type !== "host") return envelope;
  return { ...envelope, source: { type: "browser", id: handshake.clientId } };
}

/**
 * A hand-edited browser bundle cannot exceed the manifest slice: identity comes
 * from the host-attributed source, never from the envelope payload.
 */
function sliceDenial(
  envelope: BridgeEnvelope,
  message: MessageDefinition,
  handshake: Handshake,
  audit?: (entry: CapabilityAuditEntry) => void,
): BridgeError | undefined {
  if (handshake.messageRegistry?.lookup(message.name) !== undefined) return undefined;
  if (handshake.coreSlices === undefined) return undefined;
  if (envelope.source.type !== "browser" && envelope.source.type !== "plugin") return undefined;
  if (envelope.source.id === FIRST_PARTY_BRIDGE_CLIENT) return undefined;
  if (handshake.coreSlices.get(envelope.source.id)?.includes(message.name) === true) return undefined;
  const error = bridgeMessageDenied(envelope.source.id, message.name);
  audit?.({ source: envelope.source.id, capability: BRIDGE_MESSAGE_DENIED, message: message.name });
  return error;
}

/** Plugin- and browser-originated messages need a declared, granted capability. */
export function gate(
  message: MessageDefinition,
  envelope: BridgeEnvelope,
  handshake: Handshake,
  audit?: (entry: CapabilityAuditEntry) => void,
): BridgeError | undefined {
  const deniedSlice = sliceDenial(envelope, message, handshake, audit);
  if (deniedSlice !== undefined) return deniedSlice;
  const capability = message.capability;
  if (capability === undefined || envelope.source.type === "core" || envelope.source.type === "host") {
    return undefined;
  }
  const requested = parseCapability(capability);
  const grants = envelope.source.type === "browser" ? handshake.grants : handshake.pluginGrants;
  if (requested.ok && isGrantedCapability(grants, requested.value)) return undefined;

  const error = bridgeError("CAPABILITY_DENIED", `${envelope.source.type} "${envelope.source.id}" cannot ${message.name}`, {
    plugin: envelope.source.id,
    capability,
  });
  audit?.({ source: envelope.source.id, capability, message: message.name });
  return error;
}

export function handshakeRequired(): BridgeError {
  return bridgeError("INTERNAL", "bridge.hello must precede commands and queries");
}

export function dispatchError(message: string, name?: string): BridgeError {
  return bridgeError("UNKNOWN_MESSAGE", message, name === undefined ? undefined : { message: name });
}

export function reply(envelope: BridgeEnvelope, payload: unknown, options: {
  sequence?: number;
  cursor?: string;
  error?: BridgeError;
} = {}): BindingReply {
  const value: BridgeEnvelope = {
    ...envelope,
    source: { type: "host", id: "protocol-host" },
    target: envelope.source,
    payload,
  };
  if (options.sequence !== undefined) value.sequence = options.sequence;
  if (options.cursor !== undefined) value.cursor = options.cursor;
  if (options.error !== undefined) value.error = options.error;
  return { ok: true, value };
}

export function messageFor(envelope: BridgeEnvelope, registry?: BindingOptions["messageRegistry"]): MessageDefinition | undefined {
  return resolveMessage(envelope.name, registry);
}
