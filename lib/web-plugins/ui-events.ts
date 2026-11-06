import { validatePlacement, type WebPluginPlacement } from "./ui-contract.ts";
import { validateView, type WebView } from "./view.ts";

export const WEB_UI_EVENT = "web-ui:event";
export interface WorkingModel { message: string | null; visible: boolean; frames: string[] | null; intervalMs: number }
export interface WebUiPayloads {
  "ui.working.changed": Partial<WorkingModel>;
  "ui.status.changed": { key: string; text: string | null };
  "ui.widget.changed": { key: string; lines: string[] | null; placement: "aboveEditor" | "belowEditor" };
  "ui.custom.changed": { id: string; method: string; lines: string[] | null };
  "ui.title.changed": { text: string };
  "ui.editor.changed": { text: string };
  "ui.view.changed": { pluginId: string; view: WebView };
  "ui.layout.changed": { pluginId: string; contributionId: string; placement: WebPluginPlacement };
  "ui.session.lifecycle": { running: boolean; closed?: boolean; project?: string };
  "ui.plugin.action-requested": { pluginId: string; actionId: string; requestId: string };
}
export type WebUiType = keyof WebUiPayloads;
export type WebUiEvent<K extends WebUiType = WebUiType> = K extends WebUiType ? {
  version: 1; eventId: string; sessionId: string; source: "extension" | "host" | "browser";
  sourceKey: string; type: K; timestamp: number; sequence: number; payload: WebUiPayloads[K];
} : never;
export type UiValidation = { ok: true; event: WebUiEvent } | { ok: false; error: string };

/** Strip terminal styling, OSC/DCS and unsupported controls. HTML stays inert text. */
export function webUiText(text: string): string {
  return text
    // Deliberate ANSI/control matching: no terminal escapes reach browser models.
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b(?:\][\s\S]*?(?:\x07|\x1b\\)|[PX^_][\s\S]*?\x1b\\|\[[0-?]*[ -/]*[@-~]|[@-_])/g, "")
    // oxlint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function text(value: unknown, max = 8192): value is string { return typeof value === "string" && value.length <= max; }
function key(value: unknown): value is string { return typeof value === "string" && /^[a-zA-Z0-9_./:@-]{1,160}$/.test(value) && !["__proto__", "constructor", "prototype"].includes(value); }
function lines(value: unknown): value is string[] { return Array.isArray(value) && value.length <= 200 && value.every(v => text(v)); }
function safeCopy(value: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error("event nesting exceeds 8");
  if (typeof value === "string") return webUiText(value);
  if (value === null || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return value;
  if (Array.isArray(value)) return value.map(v => safeCopy(v, depth + 1));
  if (record(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (["__proto__", "constructor", "prototype"].includes(k)) throw new Error("unsafe object key");
      if (v !== undefined) out[k] = safeCopy(v, depth + 1);
    }
    return out;
  }
  throw new Error("event must contain finite JSON data");
}
export function validateWebUiEvent(input: unknown): UiValidation {
  try {
    if (new TextEncoder().encode(JSON.stringify(input)).length > 65536) throw new Error("event exceeds 65536 bytes");
    const e = safeCopy(input);
    if (!record(e) || e.version !== 1 || !key(e.eventId) || !key(e.sessionId) || !key(e.sourceKey) || !["extension", "host", "browser"].includes(String(e.source)) || !Number.isSafeInteger(e.sequence) || Number(e.sequence) < 1 || typeof e.timestamp !== "number" || e.timestamp < 0 || !record(e.payload)) throw new Error("invalid event envelope");
    const p = e.payload;
    const fields: Partial<Record<WebUiType, string[]>> = {
      "ui.working.changed": ["message", "visible", "frames", "intervalMs"], "ui.status.changed": ["key", "text"],
      "ui.widget.changed": ["key", "lines", "placement"], "ui.custom.changed": ["id", "method", "lines"],
      "ui.title.changed": ["text"], "ui.editor.changed": ["text"], "ui.view.changed": ["pluginId", "view"],
      "ui.layout.changed": ["pluginId", "contributionId", "placement"], "ui.session.lifecycle": ["running", "closed", "project"],
      "ui.plugin.action-requested": ["pluginId", "actionId", "requestId"],
    };
    const allowed = fields[e.type as WebUiType];
    if (!allowed || Object.keys(p).some(k => !allowed.includes(k))) throw new Error("unknown event type or payload fields");
    let valid = false;
    switch (e.type) {
      case "ui.working.changed":
        valid = Object.keys(p).length > 0 && (p.message === undefined || p.message === null || text(p.message)) && (p.visible === undefined || typeof p.visible === "boolean") && (p.frames === undefined || p.frames === null || (Array.isArray(p.frames) && p.frames.length <= 120 && p.frames.every(f => text(f, 128)))) && (p.intervalMs === undefined || (Number.isInteger(p.intervalMs) && Number(p.intervalMs) >= 40 && Number(p.intervalMs) <= 10000)); break;
      case "ui.status.changed": valid = key(p.key) && (p.text === null || text(p.text)); break;
      case "ui.widget.changed": valid = key(p.key) && (p.lines === null || lines(p.lines)) && ["aboveEditor", "belowEditor"].includes(String(p.placement)); break;
      case "ui.custom.changed": valid = key(p.id) && text(p.method, 80) && (p.lines === null || lines(p.lines)); break;
      case "ui.title.changed": case "ui.editor.changed": valid = text(p.text); break;
      case "ui.view.changed": {
        const view = validateView(p.view); valid = key(p.pluginId) && view.ok;
        if (view.ok) p.view = view.view;
        break;
      }
      case "ui.layout.changed": {
        const placement = validatePlacement(p.placement); valid = key(p.pluginId) && key(p.contributionId) && placement.ok;
        if (placement.ok) p.placement = placement.value;
        break;
      }
      case "ui.session.lifecycle": valid = typeof p.running === "boolean" && (p.closed === undefined || typeof p.closed === "boolean") && (p.project === undefined || text(p.project, 4096)); break;
      case "ui.plugin.action-requested": valid = key(p.pluginId) && key(p.actionId) && key(p.requestId); break;
    }
    if (!valid) throw new Error(`invalid ${String(e.type)} payload`);
    return { ok: true, event: e as WebUiEvent };
  } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "invalid event" }; }
}

/** Normalize legacy RPC UI requests without consuming their response protocol. */
export function extensionUiUpdate(raw: Record<string, unknown>): { type: WebUiType; payload: unknown; sourceKey: string } | undefined {
  const sourceKey = String(raw.statusKey ?? raw.widgetKey ?? raw.id ?? "ctx.ui");
  switch (raw.method) {
    case "setStatus": return { type: "ui.status.changed", payload: { key: raw.statusKey, text: raw.statusText ?? null }, sourceKey };
    case "setWidget": return { type: "ui.widget.changed", payload: { key: raw.widgetKey, lines: raw.widgetLines ?? null, placement: raw.widgetPlacement ?? "aboveEditor" }, sourceKey };
    case "setTitle": return { type: "ui.title.changed", payload: { text: raw.title }, sourceKey: "title" };
    case "set_editor_text": return { type: "ui.editor.changed", payload: { text: raw.text }, sourceKey: "editor" };
    default: return { type: "ui.custom.changed", payload: { id: raw.id, method: raw.method, lines: raw.lines ?? (typeof raw.message === "string" ? [raw.message] : null) }, sourceKey };
  }
}
