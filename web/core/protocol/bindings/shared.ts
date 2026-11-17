/** Envelope-level rules shared by every binding, independent of transport. */
import { lookupMessage, type MessageDefinition } from "../catalog.ts";
import type { BridgeEnvelope } from "../envelope.ts";
import { bridgeError, type BridgeError } from "../errors.ts";
import { formatCapability, parseCapability } from "../../plugin-contracts/kernel/capabilities.ts";
import { BINDING_NAMES, BRIDGE_PROTOCOL_VERSION, versionMismatch, type Hello, type HelloAck } from "../version.ts";
import type { BindingName, BindingOptions, BindingReply } from "./types.ts";

function grantedSet(capabilities: readonly string[]): Set<string> {
  return new Set(capabilities);
}

export function helloAck(hello: Hello, options: BindingOptions): BindingReply<HelloAck> {
  if (hello.version !== BRIDGE_PROTOCOL_VERSION) {
    return { ok: false, error: versionMismatch(hello.version) };
  }
  if (!hello.bindings.includes(options.name)) {
    return { ok: false, error: bridgeError("UNSUPPORTED_BINDING", `binding "${options.name}" is not supported by the client`) };
  }
  const granted = grantedSet(options.grantedCapabilities);
  const ack: HelloAck = {
    version: BRIDGE_PROTOCOL_VERSION,
    capabilities: hello.capabilities.filter((capability) => granted.has(capability)),
    bindings: [...BINDING_NAMES] as BindingName[],
    sessionId: options.sessionId,
    cursor: options.initialCursor ?? "0",
  };
  return { ok: true, value: ack };
}

/** Plugin-originated messages need their declared capability; core messages do not. */
export function gate(message: MessageDefinition, envelope: BridgeEnvelope, options: BindingOptions): BridgeError | undefined {
  if (message.capability === undefined || envelope.source.type === "core" || envelope.source.type === "host") {
    return undefined;
  }
  const requested = parseCapability(message.capability);
  if (!requested.ok || !grantedSet(options.grantedCapabilities).has(formatCapability(requested.value))) {
    return bridgeError("CAPABILITY_DENIED", `plugin "${envelope.source.id}" cannot ${message.name}`, {
      plugin: envelope.source.id,
      capability: message.capability,
    });
  }
  return undefined;
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

export function messageFor(envelope: BridgeEnvelope): MessageDefinition | undefined {
  return lookupMessage(envelope.name);
}
