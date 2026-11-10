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

export type PiApiName = "autocomplete.suggestions" | "commands.builtin";

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
}

/** results per api — one entry per PiApiName. */
export interface PiApiResult {
  "autocomplete.suggestions": PiAutocompleteSuggestions | null;
  "commands.builtin": Array<{ name: string; description?: string; argumentHint?: string }>;
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
  if (api !== "autocomplete.suggestions" && api !== "commands.builtin") {
    return { error: `unknown pi api: ${String(api)}` };
  }
  if (api === "autocomplete.suggestions") {
    const p = params as { line?: unknown; cursorCol?: unknown } | undefined;
    if (typeof p?.line !== "string" || typeof p?.cursorCol !== "number" || !Number.isInteger(p.cursorCol)) {
      return { error: "autocomplete.suggestions params: {line: string, cursorCol: number}" };
    }
    if (p.cursorCol < 0 || p.cursorCol > p.line.length) return { error: "cursorCol out of range" };
  }
  return { api, params };
}
