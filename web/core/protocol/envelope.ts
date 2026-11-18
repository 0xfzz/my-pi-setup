/** Compatibility shim: envelope validation lives in the standalone SDK. */
export {
  BridgeEnvelopeSchema,
  ENVELOPE_MAX_BYTES,
  ENVELOPE_MAX_DEPTH,
  UNSAFE_KEYS,
  parseEnvelope,
} from "@pi/web-bridge";
export type { BridgeEnvelope, EnvelopeValidation } from "@pi/web-bridge";
