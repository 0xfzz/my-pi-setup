/** Pure registry for plugin-owned namespaced messages; the core catalog stays frozen. */
import { Value } from "typebox/value";

import { lookupMessage, MESSAGE_NAMES, protocolInvoke, type MessageDefinition } from "./catalog.ts";
import { ENVELOPE_MAX_BYTES, inertJsonValue } from "./envelope.ts";
import { bridgeError, type BridgeError } from "./errors.ts";

/** Distinct from the bridge extension's loop-guard marker. */
export const BRIDGE_VALIDATION_MARKER = "__piBridgeValidated";
export const BRIDGE_RELAY_MARKER = "__bridgedByBridgeExtension";

export type PluginMessageKind = "event" | "command" | "query";

export interface PluginMessageDeclaration {
  readonly name: string;
  readonly kind: PluginMessageKind;
  readonly schema: Record<string, unknown>;
  readonly maxBytes?: number;
}

export interface RegisteredPluginMessage extends PluginMessageDeclaration {
  readonly pluginId: string;
  readonly capability: string;
}

export interface PluginMessageValidation {
  ok: true;
  value: unknown;
}

export interface PluginMessageRegistry {
  register(pluginId: string, declarations: readonly PluginMessageDeclaration[]): () => void;
  lookup(name: string): RegisteredPluginMessage | undefined;
  capabilities(): readonly string[];
  names(): readonly Readonly<{ name: string; kind: PluginMessageKind }>[];
  validatePayload(name: string, payload: unknown): PluginMessageValidation | { ok: false; error: BridgeError };
}

export interface PluginMessageRegistryOptions {
  readonly coreNames?: readonly string[];
  readonly protectedNames?: readonly string[];
}

const SCHEMA_MAX_BYTES = 8192;
const PLUGIN_ID_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)*$/;
const MESSAGE_NAME_PATTERN = /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/;
const MESSAGE_KINDS: readonly PluginMessageKind[] = ["event", "command", "query"];
const SCHEMA_KEYS = new Set([
  "type", "properties", "required", "items", "additionalProperties", "enum", "const",
  "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "minLength", "maxLength",
  "minItems", "maxItems", "uniqueItems", "description", "title", "default",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function jsonBytes(value: unknown): number | undefined {
  try {
    const text = JSON.stringify(value, (_key, entry) => {
      if (entry === undefined || typeof entry === "function" || typeof entry === "symbol" || typeof entry === "bigint") {
        throw new Error("non-JSON value");
      }
      return entry;
    });
    return text === undefined ? undefined : new TextEncoder().encode(text).length;
  } catch {
    return undefined;
  }
}

function isRestrictedSchema(value: unknown, depth = 0): value is Record<string, unknown> {
  if (depth > 8 || !isRecord(value)) return false;
  const bytes = jsonBytes(value);
  if (bytes === undefined || bytes > SCHEMA_MAX_BYTES) return false;
  if (Object.keys(value).some((key) => !SCHEMA_KEYS.has(key))) return false;
  if ("properties" in value) {
    if (!isRecord(value.properties)) return false;
    if (Object.values(value.properties).some((schema) => !isRestrictedSchema(schema, depth + 1))) return false;
  }
  if ("items" in value && !isRestrictedSchema(value.items, depth + 1)) return false;
  if ("additionalProperties" in value && typeof value.additionalProperties === "object"
    && !isRestrictedSchema(value.additionalProperties, depth + 1)) return false;
  if ("required" in value && (!Array.isArray(value.required) || value.required.some((key) => typeof key !== "string"))) return false;
  if ("enum" in value && (!Array.isArray(value.enum) || jsonBytes(value.enum) === undefined)) return false;
  return true;
}

function isDeclaration(value: unknown): value is PluginMessageDeclaration {
  if (!isRecord(value)) return false;
  if (typeof value.name !== "string" || !MESSAGE_NAME_PATTERN.test(value.name)
    || !MESSAGE_KINDS.includes(value.kind as PluginMessageKind)) return false;
  if (!isRestrictedSchema(value.schema)) return false;
  return value.maxBytes === undefined
    || (typeof value.maxBytes === "number" && value.maxBytes > 0 && value.maxBytes <= ENVELOPE_MAX_BYTES);
}

function capabilityFor(declaration: PluginMessageDeclaration): string {
  return declaration.kind === "command" ? protocolInvoke(declaration.name) : "ui.publish";
}

interface RegistrationContext {
  readonly coreNames: ReadonlySet<string>;
  readonly protectedNames: readonly string[];
}

function registrationRefusal(context: RegistrationContext, pluginId: string, declaration: unknown, seen: ReadonlySet<string>): string | undefined {
  if (!isDeclaration(declaration)) return `invalid plugin message declaration ${String(declaration)}`;
  if (context.coreNames.has(declaration.name) || lookupMessage(declaration.name) !== undefined) {
    return `"${declaration.name}" shadows a core catalog message`;
  }
  if (context.protectedNames.some((prefix) => declaration.name.startsWith(prefix))) {
    return `"${declaration.name}" uses a protected prefix`;
  }
  if (!declaration.name.startsWith(`${pluginId}.`)) return `"${declaration.name}" is outside namespace "${pluginId}"`;
  if (seen.has(declaration.name)) return `duplicate plugin message "${declaration.name}"`;
  return undefined;
}

function withoutKey(payload: unknown, key: string): unknown {
  if (!isRecord(payload) || !Object.hasOwn(payload, key)) return payload;
  const next = { ...payload };
  delete next[key];
  return next;
}

export function validationMarkOf(payload: unknown): { pluginId: string; name: string } | undefined {
  const mark = isRecord(payload) ? payload[BRIDGE_VALIDATION_MARKER] : undefined;
  if (!isRecord(mark) || typeof mark.pluginId !== "string" || typeof mark.name !== "string") return undefined;
  return { pluginId: mark.pluginId, name: mark.name };
}

/** The SDK's cross-process proof; the host binding never trusts it for schema checks. */
export function markValidatedPayload(payload: unknown, registration: RegisteredPluginMessage): unknown {
  const mark = { pluginId: registration.pluginId, name: registration.name };
  return isRecord(payload)
    ? { ...payload, [BRIDGE_VALIDATION_MARKER]: mark }
    : { value: payload, [BRIDGE_VALIDATION_MARKER]: mark };
}

export function stripRelayMarker(payload: unknown): unknown {
  return withoutKey(payload, BRIDGE_RELAY_MARKER);
}

export function stripValidationMarker(payload: unknown): unknown {
  return withoutKey(payload, BRIDGE_VALIDATION_MARKER);
}

function unwrapValidationPayload(payload: unknown): unknown {
  const clean = stripRelayMarker(payload);
  if (validationMarkOf(clean) === undefined) return clean;
  if (isRecord(clean) && Object.keys(clean).length === 2 && Object.hasOwn(clean, "value")) return clean.value;
  return stripValidationMarker(clean);
}

export function payloadForDelivery(payload: unknown): unknown {
  return unwrapValidationPayload(payload);
}

let activeRegistry: PluginMessageRegistry | undefined;

export function activePluginMessageRegistry(): PluginMessageRegistry | undefined {
  return activeRegistry;
}

/** Fail-closed default for the bridge extension; the disposer restores the prior registry. */
export function setActivePluginMessageRegistry(registry: PluginMessageRegistry | undefined): () => void {
  const previous = activeRegistry;
  activeRegistry = registry;
  return () => {
    if (activeRegistry === registry) activeRegistry = previous;
  };
}

export function createPluginMessageRegistry(options: PluginMessageRegistryOptions = {}): PluginMessageRegistry {
  const entries = new Map<string, RegisteredPluginMessage>();
  const context: RegistrationContext = {
    coreNames: new Set(options.coreNames ?? MESSAGE_NAMES),
    protectedNames: options.protectedNames ?? ["core."],
  };

  function register(pluginId: string, declarations: readonly PluginMessageDeclaration[]): () => void {
    if (!PLUGIN_ID_PATTERN.test(pluginId) || pluginId.startsWith("core.")) {
      throw new Error(`invalid plugin id "${pluginId}"`);
    }
    const batch = new Set<string>();
    for (const declaration of declarations) {
      const name = isRecord(declaration) ? declaration.name : undefined;
      if (typeof name === "string" && entries.has(name)) throw new Error(`duplicate plugin message "${name}"`);
      const reason = registrationRefusal(context, pluginId, declaration, batch);
      if (reason !== undefined) throw new Error(reason);
      batch.add(declaration.name);
    }
    const owned = declarations.map((declaration) => ({
      ...declaration,
      schema: structuredClone(declaration.schema),
      pluginId,
      capability: capabilityFor(declaration),
    }));
    for (const entry of owned) entries.set(entry.name, entry);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      for (const entry of owned) {
        if (entries.get(entry.name) === entry) entries.delete(entry.name);
      }
    };
  }

  function validatePayload(name: string, payload: unknown): PluginMessageValidation | { ok: false; error: BridgeError } {
    const entry = entries.get(name);
    if (entry === undefined) {
      return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unregistered plugin message "${name}"`) };
    }
    const clean = unwrapValidationPayload(payload);
    let inert: unknown;
    try {
      inert = inertJsonValue(clean);
    } catch (error) {
      return { ok: false, error: bridgeError("VALIDATION_FAILED", error instanceof Error ? error.message : "invalid payload") };
    }
    const bytes = jsonBytes(inert);
    const limit = entry.maxBytes ?? ENVELOPE_MAX_BYTES;
    if (bytes === undefined || bytes > limit) {
      return { ok: false, error: bridgeError("VALIDATION_FAILED", `plugin message payload exceeds ${limit} bytes`) };
    }
    try {
      if (!Value.Check(entry.schema, inert)) {
        return { ok: false, error: bridgeError("VALIDATION_FAILED", `payload does not match schema for "${name}"`) };
      }
    } catch {
      return { ok: false, error: bridgeError("VALIDATION_FAILED", `payload cannot be checked for "${name}"`) };
    }
    return { ok: true, value: inert };
  }

  return {
    register,
    lookup: (name) => entries.get(name),
    capabilities: () => [...new Set([...entries.values()].map((entry) => entry.capability))].sort(),
    names: () => [...entries.values()].map(({ name, kind }) => ({ name, kind })),
    validatePayload,
  };
}

/** Catalog first; registered custom names are a second lookup source, never a mutation. */
export function resolveMessage(name: string, registry: PluginMessageRegistry | undefined = activeRegistry): MessageDefinition | undefined {
  const core = lookupMessage(name);
  if (core !== undefined) return core;
  const custom = registry?.lookup(name);
  if (custom === undefined) return undefined;
  return {
    name,
    kind: custom.kind,
    legacy: [],
    capability: custom.capability,
    description: `plugin message owned by ${custom.pluginId}`,
  };
}
