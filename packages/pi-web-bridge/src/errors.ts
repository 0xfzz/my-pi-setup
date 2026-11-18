/**
 * The protocol's one error shape. No stack, token, header or transport detail
 * ever crosses the seam in here; bindings map their own failures to these codes.
 */
import { Type, type Static } from "typebox";

export const BRIDGE_ERROR_CODES = [
  "VERSION_MISMATCH",
  "CAPABILITY_DENIED",
  "BRIDGE_MESSAGE_DENIED",
  "VALIDATION_FAILED",
  "RATE_LIMITED",
  "UNKNOWN_MESSAGE",
  "UNSUPPORTED_BINDING",
  "ADAPTER_UNAVAILABLE",
  "SESSION_NOT_FOUND",
  "INTERNAL",
] as const;

export type BridgeErrorCode = (typeof BRIDGE_ERROR_CODES)[number];

export const BridgeErrorSchema = Type.Object({
  code: Type.Unsafe<BridgeErrorCode>({ type: "string", enum: [...BRIDGE_ERROR_CODES] }),
  message: Type.String({ maxLength: 2000 }),
  retryable: Type.Boolean(),
  details: Type.Optional(Type.Record(Type.String(), Type.Union([
    Type.String(), Type.Number(), Type.Boolean(), Type.Null(),
  ]))),
}, { additionalProperties: false });

export type BridgeError = Static<typeof BridgeErrorSchema>;

const RETRYABLE_CODES: ReadonlySet<BridgeErrorCode> = new Set(["RATE_LIMITED", "ADAPTER_UNAVAILABLE"]);

export function bridgeError(
  code: BridgeErrorCode,
  message: string,
  details?: BridgeError["details"],
): BridgeError {
  return {
    code,
    message,
    retryable: RETRYABLE_CODES.has(code),
    ...(details === undefined ? {} : { details }),
  };
}
