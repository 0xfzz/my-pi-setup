/**
 * The envelope's structural check, kept as straight code rather than an
 * interpreted TypeBox schema: every bridge message runs this on both sides,
 * so the per-call schema walk dominated the profile. The rules mirror
 * `BridgeEnvelopeSchema` and `BridgeErrorSchema` exactly.
 */
import { MESSAGE_NAMES } from "./catalog.ts";
import { BRIDGE_ERROR_CODES, type BridgeError } from "./errors.ts";
import { BRIDGE_PROTOCOL } from "./version.ts";

type EndpointType = "core" | "extension" | "plugin" | "browser" | "host";

export interface EndpointShape {
  type: EndpointType;
  id: string;
}

export interface EnvelopeShape {
  protocol: typeof BRIDGE_PROTOCOL;
  version: number;
  kind: "command" | "query" | "event" | "capability";
  name: string;
  messageId: string;
  sessionId?: string;
  source: EndpointShape;
  target?: EndpointShape;
  timestamp: number;
  sequence?: number;
  cursor?: string;
  payload: unknown;
  error?: BridgeError;
}

const ENVELOPE_KEYS: ReadonlySet<string> = new Set([
  "protocol", "version", "kind", "name", "messageId", "sessionId",
  "source", "target", "timestamp", "sequence", "cursor", "payload", "error",
]);
const KINDS: ReadonlySet<string> = new Set(["command", "query", "event", "capability"]);
const ENDPOINT_TYPES: ReadonlySet<string> = new Set(["core", "extension", "plugin", "browser", "host"]);
const CORE_NAMES: ReadonlySet<string> = new Set(MESSAGE_NAMES);
const ERROR_CODES: ReadonlySet<string> = new Set(BRIDGE_ERROR_CODES);

type Data = Record<string, unknown>;

const isRecord = (value: unknown): value is Data =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function hasOnlyKeys(value: Data, keys: ReadonlySet<string>): boolean {
  for (const key of Object.keys(value)) if (!keys.has(key)) return false;
  return true;
}

function boundedString(value: unknown, max: number, min = 1): boolean {
  return typeof value === "string" && value.length >= min && value.length <= max;
}

function endpoint(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ENDPOINT_TYPES_ENDPOINT_KEYS)) return false;
  return ENDPOINT_TYPES.has(value.type as string)
    && boundedString(value.id, 160);
}

const ENDPOINT_TYPES_ENDPOINT_KEYS: ReadonlySet<string> = new Set(["type", "id"]);
const ERROR_KEYS: ReadonlySet<string> = new Set(["code", "message", "retryable", "details"]);

function errorDetails(value: unknown): boolean {
  if (!isRecord(value)) return false;
  for (const entry of Object.values(value)) {
    if (entry !== null && typeof entry !== "string" && typeof entry !== "number" && typeof entry !== "boolean") return false;
  }
  return true;
}

function bridgeError(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ERROR_KEYS)) return false;
  return ERROR_CODES.has(value.code as string)
    && boundedString(value.message, 2000, 0)
    && typeof value.retryable === "boolean"
    && (value.details === undefined || errorDetails(value.details));
}

/** The fast equivalent of `Value.Check(BridgeEnvelopeSchema, value, allowedNames)`. */
export function isEnvelopeShape(value: unknown, allowedNames: readonly string[] = []): value is EnvelopeShape {
  if (!isRecord(value) || !hasOnlyKeys(value, ENVELOPE_KEYS)) return false;
  if (value.protocol !== BRIDGE_PROTOCOL) return false;
  if (!Number.isInteger(value.version) || (value.version as number) < 1) return false;
  if (typeof value.kind !== "string" || !KINDS.has(value.kind)) return false;
  if (typeof value.name !== "string" || (!CORE_NAMES.has(value.name) && !allowedNames.includes(value.name))) return false;
  if (!boundedString(value.messageId, 160)) return false;
  if (!endpoint(value.source)) return false;
  if (value.target !== undefined && !endpoint(value.target)) return false;
  if (typeof value.timestamp !== "number" || !Number.isFinite(value.timestamp) || value.timestamp < 0) return false;
  if (value.sequence !== undefined && (!Number.isInteger(value.sequence) || (value.sequence as number) < 1)) return false;
  if (value.cursor !== undefined && !boundedString(value.cursor, 512, 0)) return false;
  if (!Object.hasOwn(value, "payload")) return false;
  return value.error === undefined || bridgeError(value.error);
}
