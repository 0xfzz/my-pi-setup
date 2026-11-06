export const WEB_PLUGIN_VIEW_EVENT = "web-plugin:view";

export const VIEW_MAX_ROWS = 200;
export const VIEW_MAX_CELL_CHARS = 500;
export const VIEW_MAX_BYTES = 65536;
export const STATUS_TONES = ["neutral", "accent", "success", "warning", "danger"] as const;

export type StatusTone = (typeof STATUS_TONES)[number];

export interface KvRow {
  label: string;
  value: string;
}

export interface KvWebView {
  type: "kv";
  title?: string;
  rows: KvRow[];
  omitted?: number;
}

export interface ListWebView {
  type: "list";
  title?: string;
  items: string[];
  omitted?: number;
}

export interface StatusWebView {
  type: "status";
  tone: StatusTone;
  text: string;
}

export type WebView = KvWebView | ListWebView | StatusWebView;

export type ValidateViewResult =
  | { ok: true; view: WebView; warnings?: string[] }
  | { ok: false; error: string };

function clampCell(text: string, fieldName: string, warnings: string[]): string {
  if (text.length <= VIEW_MAX_CELL_CHARS) {
    return text;
  }
  warnings.push(`${fieldName} truncated to ${VIEW_MAX_CELL_CHARS} characters`);
  return text.slice(0, VIEW_MAX_CELL_CHARS - 1) + "…";
}

function byteLength(obj: unknown): number {
  return new TextEncoder().encode(JSON.stringify(obj)).length;
}

export function validateView(input: unknown): ValidateViewResult {
  try {
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      return { ok: false, error: "View must be a non-null object" };
    }

    const raw = input as Record<string, unknown>;
    if (typeof raw.type !== "string") {
      return { ok: false, error: "View type must be a string" };
    }

    const warnings: string[] = [];

    let cleanTitle: string | undefined;
    if (raw.title !== undefined) {
      if (typeof raw.title !== "string") {
        return { ok: false, error: "View title must be a string" };
      }
      cleanTitle = clampCell(raw.title, "Title", warnings);
    }

    if (raw.type === "status") {
      if (typeof raw.tone !== "string" || !STATUS_TONES.includes(raw.tone as StatusTone)) {
        return { ok: false, error: `Invalid status tone: ${String(raw.tone)}` };
      }
      if (typeof raw.text !== "string") {
        return { ok: false, error: "Status text must be a string" };
      }
      const cleanText = clampCell(raw.text, "Status text", warnings);
      const view: StatusWebView = {
        type: "status",
        tone: raw.tone as StatusTone,
        text: cleanText,
      };
      return {
        ok: true,
        view,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "kv") {
      if (!Array.isArray(raw.rows)) {
        return { ok: false, error: "kv rows must be an array" };
      }

      for (let i = 0; i < raw.rows.length; i++) {
        const row = raw.rows[i];
        if (typeof row !== "object" || row === null || Array.isArray(row)) {
          return { ok: false, error: `kv row at index ${i} must be an object` };
        }
        if (typeof row.label !== "string" || typeof row.value !== "string") {
          return { ok: false, error: `kv row at index ${i} label and value must be strings` };
        }
      }

      let rows: KvRow[] = raw.rows.map((row: { label: string; value: string }, idx: number) => ({
        label: clampCell(row.label, `Row ${idx} label`, warnings),
        value: clampCell(row.value, `Row ${idx} value`, warnings),
      }));

      let omitted =
        typeof raw.omitted === "number" && Number.isFinite(raw.omitted) && raw.omitted > 0
          ? Math.floor(raw.omitted)
          : 0;

      if (rows.length > VIEW_MAX_ROWS) {
        const excess = rows.length - VIEW_MAX_ROWS;
        omitted += excess;
        rows = rows.slice(0, VIEW_MAX_ROWS);
        warnings.push(`Rows capped at ${VIEW_MAX_ROWS} (${excess} omitted)`);
      }

      let candidate: KvWebView = {
        type: "kv",
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        rows,
        ...(omitted > 0 ? { omitted } : {}),
      };

      const hadInitialByteFit = byteLength(candidate) > VIEW_MAX_BYTES;
      while (byteLength(candidate) > VIEW_MAX_BYTES && rows.length > 0) {
        const dropCount = Math.max(1, Math.ceil(rows.length * 0.1));
        rows = rows.slice(0, rows.length - dropCount);
        omitted += dropCount;
        candidate = {
          type: "kv",
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          rows,
          omitted,
        };
      }

      if (byteLength(candidate) > VIEW_MAX_BYTES) {
        return { ok: false, error: `View exceeds maximum size of ${VIEW_MAX_BYTES} bytes` };
      }

      if (hadInitialByteFit) {
        warnings.push(`View serialised size exceeded ${VIEW_MAX_BYTES} bytes; omitted rows`);
      }

      return {
        ok: true,
        view: candidate,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    if (raw.type === "list") {
      if (!Array.isArray(raw.items)) {
        return { ok: false, error: "list items must be an array" };
      }

      for (let i = 0; i < raw.items.length; i++) {
        if (typeof raw.items[i] !== "string") {
          return { ok: false, error: `list item at index ${i} must be a string` };
        }
      }

      let items: string[] = raw.items.map((item: string, idx: number) =>
        clampCell(item, `Item ${idx}`, warnings)
      );

      let omitted =
        typeof raw.omitted === "number" && Number.isFinite(raw.omitted) && raw.omitted > 0
          ? Math.floor(raw.omitted)
          : 0;

      if (items.length > VIEW_MAX_ROWS) {
        const excess = items.length - VIEW_MAX_ROWS;
        omitted += excess;
        items = items.slice(0, VIEW_MAX_ROWS);
        warnings.push(`Items capped at ${VIEW_MAX_ROWS} (${excess} omitted)`);
      }

      let candidate: ListWebView = {
        type: "list",
        ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
        items,
        ...(omitted > 0 ? { omitted } : {}),
      };

      const hadInitialByteFit = byteLength(candidate) > VIEW_MAX_BYTES;
      while (byteLength(candidate) > VIEW_MAX_BYTES && items.length > 0) {
        const dropCount = Math.max(1, Math.ceil(items.length * 0.1));
        items = items.slice(0, items.length - dropCount);
        omitted += dropCount;
        candidate = {
          type: "list",
          ...(cleanTitle !== undefined ? { title: cleanTitle } : {}),
          items,
          omitted,
        };
      }

      if (byteLength(candidate) > VIEW_MAX_BYTES) {
        return { ok: false, error: `View exceeds maximum size of ${VIEW_MAX_BYTES} bytes` };
      }

      if (hadInitialByteFit) {
        warnings.push(`View serialised size exceeded ${VIEW_MAX_BYTES} bytes; omitted items`);
      }

      return {
        ok: true,
        view: candidate,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    }

    return { ok: false, error: `Unknown view type: ${raw.type}` };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
