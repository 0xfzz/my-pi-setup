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
  | "settings.models.write"
  | "trust.read"
  | "trust.write"
  | "auth.read"
  | "auth.login"
  | "auth.state"
  | "auth.answer"
  | "auth.logout";

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
  "trust.read": Record<string, never>;
  "trust.write": {
    /** A label offered by trust.read; the server re-derives pi's option list. */
    label: string;
  };
  "auth.read": Record<string, never>;
  "auth.login": {
    providerId: string;
    authType: "oauth" | "api_key";
  };
  "auth.state": { loginId: string };
  "auth.answer": { loginId: string; value: string };
  "auth.logout": { providerId: string };
}

/** results per api — one entry per PiApiName. */
export interface PiApiResult {
  "autocomplete.suggestions": PiAutocompleteSuggestions | null;
  "commands.builtin": Array<{ name: string; description?: string; argumentHint?: string }>;
  "settings.read": { settings: PiSettingEntry[] };
  "settings.write": { key: string; value: string | number | boolean | null };
  "settings.models.read": { enabled: string[] | null };
  "settings.models.write": { enabled: string[] | null };
  "trust.read": PiTrustState;
  "trust.write": { savedDecision: PiTrustEntry | null };
  "auth.read": { providers: PiAuthProvider[]; credentials: PiAuthCredential[] };
  "auth.login": { loginId: string };
  "auth.state": PiAuthLoginState;
  "auth.answer": { ok: true };
  "auth.logout": { ok: true };
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

/** pi's project-trust state, as its own trust selector shows it. */
export interface PiTrustEntry {
  path: string;
  decision: boolean;
}

export interface PiTrustOption {
  label: string;
  trusted: boolean;
  savedPath?: string;
}

export interface PiTrustState {
  cwd: string;
  savedDecision: PiTrustEntry | null;
  options: PiTrustOption[];
}

/** pi's login providers, as its own /login selector lists them. */
export interface PiAuthProvider {
  id: string;
  name: string;
  authType: "oauth" | "api_key";
  configured: boolean;
}

export interface PiAuthCredential {
  providerId: string;
  type: "oauth" | "api_key";
}

/** A login prompt pi's ModelRuntime needs answered. */
export interface PiAuthPrompt {
  type: "text" | "secret" | "select" | "manual_code";
  message: string;
  placeholder?: string;
  options?: Array<{ id: string; label: string; description?: string }>;
}

/** An informational/auth-url/device-code event pi's flow notifies. */
export interface PiAuthEvent {
  type: "info" | "auth_url" | "device_code" | "progress";
  message?: string;
  links?: Array<{ url: string; label?: string }>;
  url?: string;
  instructions?: string;
  userCode?: string;
  verificationUri?: string;
  intervalSeconds?: number;
  expiresInSeconds?: number;
}

/** The state of one in-flight login. */
export interface PiAuthLoginState {
  status: "pending" | "done" | "error";
  error?: string | null;
  prompt?: PiAuthPrompt | null;
  event?: PiAuthEvent | null;
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
    "trust.read",
    "trust.write",
    "auth.read",
    "auth.login",
    "auth.state",
    "auth.answer",
    "auth.logout",
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
  if (api === "trust.write") {
    const p = params as { label?: unknown } | undefined;
    if (typeof p?.label !== "string" || p.label.trim() === "") {
      return { error: "trust.write params: {label: string}" };
    }
  }
  if (api === "auth.login") {
    const p = params as { providerId?: unknown; authType?: unknown } | undefined;
    if (typeof p?.providerId !== "string" || p.providerId.trim() === "") {
      return { error: "auth.login params: {providerId: string, authType: 'oauth' | 'api_key'}" };
    }
    if (p?.authType !== "oauth" && p?.authType !== "api_key") {
      return { error: "authType must be 'oauth' or 'api_key'" };
    }
  }
  if (api === "auth.state" || api === "auth.answer" || api === "auth.logout") {
    const p = params as { loginId?: unknown; value?: unknown; providerId?: unknown } | undefined;
    if (api === "auth.state" && typeof p?.loginId !== "string") {
      return { error: "auth.state params: {loginId: string}" };
    }
    if (api === "auth.answer" && (typeof p?.loginId !== "string" || typeof p?.value !== "string")) {
      return { error: "auth.answer params: {loginId: string, value: string}" };
    }
    if (api === "auth.logout" && (typeof p?.providerId !== "string" || p.providerId.trim() === "")) {
      return { error: "auth.logout params: {providerId: string}" };
    }
  }
  return { api: apiName, params };
}
