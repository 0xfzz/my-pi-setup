/**
 * Protocol identity and handshake version. Additive changes are capabilities;
 * only a change to this number invalidates an older peer.
 */
import { Type, type Static } from "typebox";
import { bridgeError, type BridgeError } from "./errors.ts";

export const BRIDGE_PROTOCOL = "pi-web-bridge";
export const BRIDGE_PROTOCOL_VERSION = 1;

export const HELLO = "bridge.hello";
export const HELLO_ACK = "bridge.hello-ack";

export const BINDING_NAMES = ["in-process", "session-attach", "http-sse"] as const;
export type BindingName = (typeof BINDING_NAMES)[number];

const BindingNameSchema = Type.Unsafe<BindingName>({ type: "string", enum: [...BINDING_NAMES] });

export const HelloSchema = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  bindings: Type.Array(BindingNameSchema, { minItems: 1 }),
  clientId: Type.String({ minLength: 1, maxLength: 160 }),
  capabilities: Type.Array(Type.String(), { maxItems: 128 }),
}, { additionalProperties: false });

export type Hello = Static<typeof HelloSchema>;

export const HelloAckSchema = Type.Object({
  version: Type.Integer({ minimum: 1 }),
  capabilities: Type.Array(Type.String(), { maxItems: 128 }),
  bindings: Type.Array(BindingNameSchema, { minItems: 1 }),
  /** Directory-level handshakes have no selected session. */
  sessionId: Type.Optional(Type.String()),
  cursor: Type.String(),
}, { additionalProperties: false });

export type HelloAck = Static<typeof HelloAckSchema>;

export function versionMismatch(peerVersion: number): BridgeError {
  return bridgeError("VERSION_MISMATCH", `peer speaks protocol v${peerVersion}; this host speaks v${BRIDGE_PROTOCOL_VERSION}`, {
    expected: BRIDGE_PROTOCOL_VERSION,
    received: peerVersion,
  });
}
