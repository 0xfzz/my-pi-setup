/**
 * Pure mapping from a bridged envelope to a host-rendered declarative view.
 * No HTML is produced: the host renders the returned view with its own
 * sanitiser and placement ceilings.
 */
import { webUiText, type BridgeEnvelope } from "@pi-web/bridge";
import {
  validateView,
  VIEW_MAX_ROWS,
  type StatusTone,
  type WebView,
} from "@pi-web/host-ui";

interface TextSurface {
  label: string;
  field: string;
  tone: StatusTone;
}

const TEXT_SURFACES: Record<string, TextSurface> = {
  "ui.header.changed": { label: "Header", field: "text", tone: "accent" },
  "ui.footer.changed": { label: "Footer", field: "text", tone: "neutral" },
  "ui.status.changed": { label: "Status", field: "text", tone: "accent" },
  "ui.title.changed": { label: "Title", field: "text", tone: "accent" },
  "ui.editor.changed": { label: "Editor", field: "text", tone: "neutral" },
  "ui.editor-component.changed": { label: "Editor component", field: "component", tone: "neutral" },
  "ui.autocomplete-provider.changed": { label: "Autocomplete", field: "provider", tone: "neutral" },
  "ui.notify": { label: "Notice", field: "message", tone: "accent" },
};

function payloadOf(envelope: BridgeEnvelope): Record<string, unknown> | undefined {
  return envelope.payload !== null && typeof envelope.payload === "object" && !Array.isArray(envelope.payload)
    ? envelope.payload as Record<string, unknown>
    : undefined;
}

function statusView(prefix: string, tone: StatusTone, text: string): WebView | undefined {
  const result = validateView({ type: "status", tone, text: `${prefix} ${text}` });
  return result.ok ? result.view : undefined;
}

function widgetView(envelope: BridgeEnvelope, payload: Record<string, unknown> | undefined): WebView | undefined {
  if (!Array.isArray(payload?.lines)) return undefined;
  const lines = payload.lines
    .filter((line): line is string => typeof line === "string" && webUiText(line).length > 0)
    .slice(0, VIEW_MAX_ROWS)
    .map(webUiText);
  if (lines.length === 0) return undefined;
  const key = typeof payload.key === "string" && payload.key !== "" ? payload.key : "widget";
  const result = validateView({
    type: "list",
    title: `Widget · ${envelope.source.id}: ${key}`,
    items: lines,
  });
  return result.ok ? result.view : undefined;
}

export function bridgedView(envelope: BridgeEnvelope): WebView | undefined {
  const payload = payloadOf(envelope);
  if (envelope.name === "ui.widget.changed") return widgetView(envelope, payload);
  const surface = TEXT_SURFACES[envelope.name];
  if (surface === undefined) return undefined;
  const raw = payload?.[surface.field];
  const text = typeof raw === "string" ? webUiText(raw) : "";
  if (text.length === 0) return undefined;
  const tone = envelope.name === "ui.notify" && payload?.level === "error" ? "danger" : surface.tone;
  return statusView(`${surface.label} · ${envelope.source.id}:`, tone, text);
}

export function bridgedSurfaceId(envelope: BridgeEnvelope): string {
  return `bridge:${envelope.source.id}:${envelope.name}`;
}
