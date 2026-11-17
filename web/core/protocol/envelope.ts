/**
 * The one object that crosses every binding. Shape checks are pure; transport
 * framing, rate limits and heartbeats belong to bindings, never here.
 */
import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { webUiText } from "../plugin-contracts/ui-event-models.ts";
import { MESSAGE_NAMES } from "./catalog.ts";
import { bridgeError, BridgeErrorSchema, type BridgeError } from "./errors.ts";
import { BRIDGE_PROTOCOL } from "./version.ts";

export const ENVELOPE_MAX_BYTES = 65_536;
export const ENVELOPE_MAX_DEPTH = 8;
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const SOURCE_TYPES = ["core", "extension", "plugin", "browser", "host"] as const;

const EndpointSchema = Type.Object({
  type: Type.Union(SOURCE_TYPES.map((type) => Type.Literal(type))),
  id: Type.String({ minLength: 1, maxLength: 160 }),
}, { additionalProperties: false });

export const BridgeEnvelopeSchema = Type.Object({
  protocol: Type.Literal(BRIDGE_PROTOCOL),
  version: Type.Integer({ minimum: 1 }),
  kind: Type.Union([
    Type.Literal("command"), Type.Literal("query"), Type.Literal("event"), Type.Literal("capability"),
  ]),
  name: Type.Union(MESSAGE_NAMES.map((name) => Type.Literal(name))),
  messageId: Type.String({ minLength: 1, maxLength: 160 }),
  sessionId: Type.Optional(Type.String({ minLength: 1, maxLength: 160 })),
  source: EndpointSchema,
  target: Type.Optional(EndpointSchema),
  timestamp: Type.Number({ minimum: 0 }),
  sequence: Type.Optional(Type.Integer({ minimum: 1 })),
  cursor: Type.Optional(Type.String({ maxLength: 512 })),
  payload: Type.Unknown(),
  error: Type.Optional(BridgeErrorSchema),
}, { additionalProperties: false });

export type BridgeEnvelope = Static<typeof BridgeEnvelopeSchema>;
export type EnvelopeValidation = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: BridgeError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Data stays data: terminal controls are stripped and hostile keys are refused. */
function inertJson(value: unknown, depth: number): unknown {
  if (depth > ENVELOPE_MAX_DEPTH) throw new Error("envelope nesting exceeds 8");
  if (typeof value === "string") return webUiText(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("envelope contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return value.map((entry) => inertJson(entry, depth + 1));
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      if (UNSAFE_KEYS.has(key)) throw new Error("unsafe object key");
      out[key] = inertJson(entry, depth + 1);
    }
    return out;
  }
  throw new Error("envelope must contain finite JSON data");
}

function validationError(message: string): EnvelopeValidation {
  return { ok: false, error: bridgeError("VALIDATION_FAILED", message) };
}

/** Validate, bound and sanitise one envelope. Never throws on hostile input. */
export function parseEnvelope(input: unknown): EnvelopeValidation {
  try {
    const inert = inertJson(input, 0);
    if (new TextEncoder().encode(JSON.stringify(inert)).length > ENVELOPE_MAX_BYTES) {
      return validationError(`envelope exceeds ${ENVELOPE_MAX_BYTES} bytes`);
    }
    if (!Value.Check(BridgeEnvelopeSchema, inert)) {
      return validationError("envelope does not match the protocol schema");
    }
    return { ok: true, envelope: inert };
  } catch (error) {
    return validationError(error instanceof Error ? error.message : "invalid envelope");
  }
}
