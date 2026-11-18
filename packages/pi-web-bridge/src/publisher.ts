/**
 * Typed opt-in publisher for extensions. It emits protocol envelopes on pi's
 * event bus; the bridge extension (and only it) turns them into web surfaces.
 * An extension imports this, never web/core/plugin-contracts/publisher.ts.
 */
import { lookupMessage } from "./catalog.ts";
import { parseEnvelope } from "./envelope.ts";
import type { BridgeEnvelope } from "./envelope.ts";
import { bridgeError, type BridgeError } from "./errors.ts";
import { markValidatedPayload, resolveMessage, validationMarkOf, type PluginMessageRegistry } from "./plugin-messages.ts";

export const BRIDGE_MESSAGE_EVENT = "bridge-protocol:message";

export interface BridgePublishTarget {
  events?: {
    emit(channel: string, data: unknown): void;
    on?(channel: string, handler: (data: unknown) => void): () => void;
  };
}

export type PublishResult = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: BridgeError };

export interface PublishOptions {
  readonly registry?: PluginMessageRegistry;
  /** Cross-process relay may forward an SDK-marked custom envelope without a local registry. */
  readonly trustMark?: boolean;
}

function ownershipDenial(source: BridgeEnvelope["source"], name: string): BridgeError {
  return bridgeError("CAPABILITY_DENIED", `${source.type} "${source.id}" cannot publish ${name}`, {
    plugin: source.id,
    message: name,
  });
}

/** Custom names need a registered declaration and an owning extension/plugin source. */
function customPayload(name: string, source: BridgeEnvelope["source"], payload: unknown, registry: PluginMessageRegistry): { ok: true; value: unknown } | { ok: false; error: BridgeError } {
  const registration = registry.lookup(name);
  if (registration === undefined) return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message ${name}`) };
  if (source.type !== "extension" && source.type !== "plugin") return { ok: false, error: ownershipDenial(source, name) };
  if (source.id !== registration.pluginId) return { ok: false, error: ownershipDenial(source, name) };
  const mark = validationMarkOf(payload);
  if (mark?.pluginId === registration.pluginId && mark.name === name) return { ok: true, value: payload };
  const validated = registry.validatePayload(name, payload);
  if (!validated.ok) return validated;
  return { ok: true, value: markValidatedPayload(validated.value, registration) };
}

export function publishBridgeMessage(
  pi: BridgePublishTarget | null | undefined,
  source: BridgeEnvelope["source"],
  name: string,
  payload: unknown,
  messageId: string,
  options: PublishOptions = {},
): PublishResult {
  const core = lookupMessage(name);
  const registration = options.registry?.lookup(name);
  const mark = validationMarkOf(payload);
  const markedCustom = options.trustMark === true && core === undefined && registration === undefined
    && mark?.name === name && mark.pluginId === source.id
    && (source.type === "extension" || source.type === "plugin")
    && name.startsWith(`${source.id}.`);
  const message = markedCustom
    ? { name, kind: "event" as const, legacy: [], capability: "ui.publish", description: "relayed plugin message" }
    : resolveMessage(name, options.registry);
  if (message === undefined || (core === undefined && registration === undefined && !markedCustom)) {
    return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message ${name}`) };
  }
  let outgoing = payload;
  if (core === undefined && registration !== undefined && options.registry !== undefined) {
    const checked = customPayload(name, source, payload, options.registry);
    if (!checked.ok) return { ok: false, error: checked.error };
    outgoing = checked.value;
  }
  const parsed = parseEnvelope({
    protocol: "pi-web-bridge",
    version: 1,
    kind: message.kind,
    name,
    messageId,
    source,
    timestamp: 0,
    payload: outgoing,
  }, options.registry?.names().map((entry) => entry.name) ?? (markedCustom ? [name] : []));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    pi?.events?.emit(BRIDGE_MESSAGE_EVENT, parsed.envelope);
    return { ok: true, envelope: parsed.envelope };
  } catch {
    return { ok: false, error: { code: "UNSUPPORTED_BINDING", message: "protocol event bus is unavailable", retryable: true } };
  }
}

/** Re-emit an observed envelope; custom names still need registry ownership. */
export function relayBridgeEnvelope(
  pi: BridgePublishTarget | null | undefined,
  envelope: BridgeEnvelope,
  options: PublishOptions = {},
): PublishResult {
  if (resolveMessage(envelope.name, options.registry) === undefined) {
    return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message ${envelope.name}`) };
  }
  return publishBridgeMessage(pi, envelope.source, envelope.name, envelope.payload, envelope.messageId, options);
}

/** ctx.ui surfaces that are no-ops in the web today gain typed envelopes. */
export function publishUiHeader(pi: BridgePublishTarget, sourceId: string, text: string, messageId: string): PublishResult {
  return publishBridgeMessage(pi, { type: "extension", id: sourceId }, "ui.header.changed", { text }, messageId);
}

export function publishUiFooter(pi: BridgePublishTarget, sourceId: string, text: string, messageId: string): PublishResult {
  return publishBridgeMessage(pi, { type: "extension", id: sourceId }, "ui.footer.changed", { text }, messageId);
}

export function publishUiEditorComponent(pi: BridgePublishTarget, sourceId: string, component: string, messageId: string): PublishResult {
  return publishBridgeMessage(pi, { type: "extension", id: sourceId }, "ui.editor-component.changed", { component }, messageId);
}

export function publishUiAutocompleteProvider(pi: BridgePublishTarget, sourceId: string, provider: string, messageId: string): PublishResult {
  return publishBridgeMessage(pi, { type: "extension", id: sourceId }, "ui.autocomplete-provider.changed", { provider }, messageId);
}
