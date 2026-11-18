/** Compatibility shim: the protocol error shape lives in the standalone SDK. */
export {
  BRIDGE_ERROR_CODES,
  BridgeErrorSchema,
  bridgeError,
} from "@pi-web/bridge";
export type { BridgeError, BridgeErrorCode } from "@pi-web/bridge";
