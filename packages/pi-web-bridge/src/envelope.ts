/**
 * The one object that crosses every binding. Shape checks are pure; transport
 * framing, rate limits and heartbeats belong to bindings, never here.
 */
import { Type, type Static } from "typebox";

import { webUiText } from "./text.ts";
import { isEnvelopeShape } from "./envelope-shape.ts";
import { MESSAGE_NAMES } from "./catalog.ts";
import { bridgeError, BridgeErrorSchema, type BridgeError } from "./errors.ts";
import { BRIDGE_PROTOCOL } from "./version.ts";

export const ENVELOPE_MAX_BYTES = 65_536;
export const ENVELOPE_MAX_DEPTH = 8;
export const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

const SOURCE_TYPES = ["core", "extension", "plugin", "browser", "host"] as const;
type EndpointType = (typeof SOURCE_TYPES)[number];

const EndpointTypeSchema = Type.Unsafe<EndpointType>({ type: "string", enum: [...SOURCE_TYPES] });

const EndpointSchema = Type.Object({
  type: EndpointTypeSchema,
  id: Type.String({ minLength: 1, maxLength: 160 }),
}, { additionalProperties: false });

const makeEnvelopeSchema = (names: readonly string[]) => Type.Object({
  protocol: Type.Literal(BRIDGE_PROTOCOL),
  version: Type.Integer({ minimum: 1 }),
  kind: Type.Unsafe<"command" | "query" | "event" | "capability">({
    type: "string", enum: ["command", "query", "event", "capability"],
  }),
  name: Type.Unsafe<string>({ type: "string", enum: [...names] }),
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

export const BridgeEnvelopeSchema = makeEnvelopeSchema(MESSAGE_NAMES);

export type BridgeEnvelope = Omit<Static<typeof BridgeEnvelopeSchema>, "name"> & { name: string };
export type EnvelopeValidation = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: BridgeError };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPlainRecord = (value: unknown): value is Record<string, unknown> => {
  if (!isRecord(value)) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

/** Copy only the branches that actually changed; clean JSON stays shared. */
function inertArray(value: unknown[], depth: number): unknown[] {
  let copy: unknown[] | undefined;
  for (let index = 0; index < value.length; index += 1) {
    const entry = value[index];
    const inert = inertJson(entry, depth + 1);
    if (inert === entry || copy !== undefined) continue;
    copy = value.slice();
  }
  if (copy === undefined) return value;
  for (let index = 0; index < value.length; index += 1) copy[index] = inertJson(value[index], depth + 1);
  return copy;
}

function inertRecord(value: Record<string, unknown>, depth: number, plain: boolean): Record<string, unknown> {
  let copy: Record<string, unknown> | undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (UNSAFE_KEYS.has(key)) throw new Error("unsafe object key");
    const inert = inertJson(entry, depth + 1);
    if (inert !== entry && copy === undefined) copy = { ...value };
    if (copy !== undefined) copy[key] = inert;
  }
  if (copy !== undefined) return copy;
  return plain ? value : { ...value };
}

/** Data stays data: terminal controls are stripped and hostile keys are refused. */
function inertJson(value: unknown, depth: number): unknown {
  if (depth > ENVELOPE_MAX_DEPTH) throw new Error("envelope nesting exceeds 8");
  if (typeof value === "string") return webUiText(value);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("envelope contains a non-finite number");
    return value;
  }
  if (Array.isArray(value)) return inertArray(value, depth);
  if (isRecord(value)) return inertRecord(value, depth, isPlainRecord(value));
  throw new Error("envelope must contain finite JSON data");
}

/** Reuse the envelope's depth, key and terminal-control guards outside parsing. */
export function inertJsonValue(value: unknown): unknown {
  return inertJson(value, 0);
}

const TEXT_ENCODER = new TextEncoder();

function validationError(message: string): EnvelopeValidation {
  return { ok: false, error: bridgeError("VALIDATION_FAILED", message) };
}

/** Validate, bound and sanitise one envelope. Never throws on hostile input. */
export function parseEnvelope(input: unknown, allowedNames: readonly string[] = []): EnvelopeValidation {
  try {
    const inert = inertJson(input, 0);
    if (TEXT_ENCODER.encode(JSON.stringify(inert)).length > ENVELOPE_MAX_BYTES) {
      return validationError(`envelope exceeds ${ENVELOPE_MAX_BYTES} bytes`);
    }
    if (!isEnvelopeShape(inert, allowedNames)) {
      return validationError("envelope does not match the protocol schema");
    }
    return { ok: true, envelope: inert };
  } catch (error) {
    return validationError(error instanceof Error ? error.message : "invalid envelope");
  }
}
