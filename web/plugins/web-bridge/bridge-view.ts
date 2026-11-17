/**
 * Pure mapping from a bridged envelope to a host-rendered declarative view.
 * No HTML is produced: the host renders the returned view with its own
 * sanitiser and placement ceilings.
 */
import type { BridgeEnvelope } from "../../core/protocol/envelope.ts";
import type { WebView } from "../../core/plugin-contracts/view.ts";

const TEXT_FIELDS: Record<string, string> = {
  "ui.header.changed": "Header",
  "ui.footer.changed": "Footer",
  "ui.status.changed": "Status",
  "ui.title.changed": "Title",
  "ui.notify": "Notice",
};

export function bridgedView(envelope: BridgeEnvelope): WebView | undefined {
  const label = TEXT_FIELDS[envelope.name];
  if (label === undefined) return undefined;
  const payload = envelope.payload as Record<string, unknown> | null;
  const text = payload?.text ?? payload?.message;
  if (typeof text !== "string" || text.length === 0 || text.length > 20_000) return undefined;
  return {
    type: "status",
    tone: envelope.name === "ui.notify" && payload?.level === "error" ? "danger" : "accent",
    text: `${label} · ${envelope.source.id}: ${text}`,
  } as WebView;
}

export function bridgedSurfaceId(envelope: BridgeEnvelope): string {
  return `bridge:${envelope.source.id}:${envelope.name}`;
}
