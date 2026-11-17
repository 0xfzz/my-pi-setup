/**
 * Typed opt-in publisher for extensions. It emits protocol envelopes on pi's
 * event bus; the bridge extension (and only it) turns them into web surfaces.
 * An extension imports this, never web/core/plugin-contracts/publisher.ts.
 */
import { lookupMessage, type MessageName } from "./catalog.ts";
import { parseEnvelope } from "./envelope.ts";
import type { BridgeEnvelope } from "./envelope.ts";
import type { BridgeError } from "./errors.ts";

export const BRIDGE_MESSAGE_EVENT = "bridge-protocol:message";

export interface BridgePublishTarget {
  events?: {
    emit(channel: string, data: unknown): void;
    on?(channel: string, handler: (data: unknown) => void): () => void;
  };
}

export type PublishResult = { ok: true; envelope: BridgeEnvelope } | { ok: false; error: BridgeError };

export function publishBridgeMessage(
  pi: BridgePublishTarget | null | undefined,
  source: BridgeEnvelope["source"],
  name: MessageName,
  payload: unknown,
  messageId: string,
): PublishResult {
  const message = lookupMessage(name);
  if (message === undefined) {
    return { ok: false, error: { code: "UNKNOWN_MESSAGE", message: `unknown protocol message ${name}`, retryable: false } };
  }
  const parsed = parseEnvelope({
    protocol: "pi-web-bridge",
    version: 1,
    kind: message.kind,
    name,
    messageId,
    source,
    timestamp: 0,
    payload,
  });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  try {
    pi?.events?.emit(BRIDGE_MESSAGE_EVENT, parsed.envelope);
    return { ok: true, envelope: parsed.envelope };
  } catch {
    return { ok: false, error: { code: "UNSUPPORTED_BINDING", message: "protocol event bus is unavailable", retryable: true } };
  }
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
