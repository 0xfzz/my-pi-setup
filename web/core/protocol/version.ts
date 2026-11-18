/** Compatibility shim: protocol identity and handshake live in the standalone SDK. */
export {
  BINDING_NAMES,
  BRIDGE_PROTOCOL,
  BRIDGE_PROTOCOL_VERSION,
  HELLO,
  HELLO_ACK,
  HelloAckSchema,
  HelloSchema,
  versionMismatch,
} from "@pi-web/bridge";
export type { BindingName, Hello, HelloAck } from "@pi-web/bridge";
