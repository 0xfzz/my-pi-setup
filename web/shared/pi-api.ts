// The pi_api contract: the web client calls pi's BUILT-IN APIs through this
// RPC surface instead of the web reimplementing them. Every api name maps to
// a real pi callable — see docs/pi-web.md for the interface map and how to
// extend it.
//
// Transport (bridged sessions):
//   POST /api/agent/:id/pi_api {api, params}
//     → the server enqueues a pi_api_request command on the bridge
//     → the extension (running inside pi) calls the native pi API
//     → the extension posts a web_api_response event (correlated by id)
//     → the server resolves the pending request and replies to the client.
// In-process sessions implement the same handler on the session core.

export type PiApiName =
  | "autocomplete.suggestions"
  | "commands.builtin"
  | "settings.read"
  | "settings.write"
  | "settings.models.read"
  | "settings.models.write";

/** pi-tui's AutocompleteItem, wire form. */
export interface PiAutocompleteItem {
  value: string;
  label: string;
  description?: string;
}

export interface PiAutocompleteSuggestions {
  items: PiAutocompleteItem[];
  prefix: string;
}

/** params per api — one entry per PiApiName. */
export interface PiApiParams {
  "autocomplete.suggestions": {
    /** The composer's current line (the editor's single line). */
    line: string;
    /** 0-based column of the caret in that line. */
    cursorCol: number;
  };
  "commands.builtin": Record<string, never>;
  "settings.read": Record<string, never>;
  "settings.write": {
    key: string;
    value: string | number | boolean | null;
  };
  "settings.models.read": Record<string, never>;
  "settings.models.write": {
    /** The enabledModels patterns; null clears scoping (all models). */
    patterns: string[] | null;
  };
}

/** results per api — one entry per PiApiName. */
export interface PiApiResult {
  "autocomplete.suggestions": PiAutocompleteSuggestions | null;
  "commands.builtin": Array<{ name: string; description?: string; argumentHint?: string }>;
  "settings.read": { settings: PiSettingEntry[] };
  "settings.write": { key: string; value: string | number | boolean | null };
  "settings.models.read": { enabled: string[] | null };
  "settings.models.write": { enabled: string[] | null };
}

/** One entry of pi's settings surface, as the web dialog renders it. */
export interface PiSettingEntry {
  key: string;
  label: string;
  description?: string;
  kind: "toggle" | "select" | "text" | "model";
  value: string | number | boolean | null;
  /** select entries: the offered choices; the current value is among them. */
  options?: Array<{ label: string; value: string | number | boolean }>;
}

export type PiApiRequest = {
  id: number;
  api: PiApiName;
  params: unknown;
};

export type PiApiResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

/** Parse a client pi_api body: {api, params}. */
export function parsePiApiBody(body: unknown): { api: PiApiName; params: unknown } | { error: string } {
  if (typeof body !== "object" || body === null) return { error: "body must be an object" };
  const { api, params } = body as { api?: unknown; params?: unknown };
  const known: readonly string[] = [
    "autocomplete.suggestions",
    "commands.builtin",
    "settings.read",
    "settings.write",
    "settings.models.read",
    "settings.models.write",
  ];
  if (typeof api !== "string" || !known.includes(api)) {
    return { error: `unknown pi api: ${String(api)}` };
  }
  const apiName = api as PiApiName;
  if (api === "autocomplete.suggestions") {
    const p = params as { line?: unknown; cursorCol?: unknown } | undefined;
    if (typeof p?.line !== "string" || typeof p?.cursorCol !== "number" || !Number.isInteger(p.cursorCol)) {
      return { error: "autocomplete.suggestions params: {line: string, cursorCol: number}" };
    }
    if (p.cursorCol < 0 || p.cursorCol > p.line.length) return { error: "cursorCol out of range" };
  }
  if (api === "settings.write") {
    const p = params as { key?: unknown; value?: unknown } | undefined;
    if (typeof p?.key !== "string" || p.key === "") {
      return { error: "settings.write params: {key: string, value: …}" };
    }
    if (
      p?.value !== null
      && typeof p?.value !== "string"
      && typeof p?.value !== "number"
      && typeof p?.value !== "boolean"
    ) {
      return { error: "value must be a string, number, boolean or null" };
    }
  }
  if (api === "settings.models.write") {
    const p = params as { patterns?: unknown } | undefined;
    if (p?.patterns !== null && !Array.isArray(p?.patterns)) {
      return { error: "settings.models.write params: {patterns: string[] | null}" };
    }
    if (
      Array.isArray(p?.patterns)
      && !(p.patterns as unknown[]).every((pattern) => typeof pattern === "string" && pattern.trim() !== "")
    ) {
      return { error: "patterns must be non-empty strings" };
    }
  }
  return { api: apiName, params };
}
