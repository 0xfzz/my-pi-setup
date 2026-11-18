/** Compatibility shim: the frozen catalog lives in the standalone SDK. */
export {
  MESSAGE_CATALOG,
  MESSAGE_KINDS,
  MESSAGE_NAMES,
  PROTOCOL_INVOKE_CAPABILITY,
  catalogCapabilities,
  catalogMarkdown,
  legacyWires,
  lookupMessage,
  protocolInvoke,
} from "@pi/web-bridge";
export type { MessageDefinition, MessageKind, MessageName } from "@pi/web-bridge";
