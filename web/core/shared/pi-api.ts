// The pi_api wire vocabulary: names, params and results for pi's BUILT-IN
// APIs. The browser reaches these through Bridge Protocol messages carried by
// POST /api/agent/:id/protocol; the retired /pi_api route is gone. The
// implementations still call pi's own modules — see docs/pi-web.md.
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
  | "auth.logout"
  | "mcp.read"
  | "mcp.write";

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
  "mcp.read": Record<string, never>;
  "mcp.write": PiMcpWriteParams;
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
  "mcp.read": PiMcpConfigState;
  "mcp.write": PiMcpConfigState;
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

/** Which mcp.json defines a server, mirroring pi's McpServerEntry scope. */
export type PiMcpScope = "global" | "project" | "extension";

/** One configured MCP server, wire form of pi's McpServerEntry. */
export interface PiMcpServerEntry {
  name: string;
  scope: PiMcpScope;
  /** The mcp.json that defines (or, for overrides, enables) this entry. */
  source: string;
  /** Set when a project mcp.json overrides this global server. */
  override?: string;
  enabled: boolean;
  exposure: string;
  transport: "stdio" | "http";
  /** stdio: one executable plus its arguments (not a shell string). */
  command?: string;
  args?: string[];
  /** http: the streamable HTTP endpoint. */
  url?: string;
  /** stdio: environment references (`${NAME}`, `!cmd`), as configured. */
  env?: Record<string, string>;
  /** http: header values, as configured. */
  headers?: Record<string, string>;
  description?: string;
}

/** pi's loaded MCP configuration, as /mcp lists it. */
export interface PiMcpConfigState {
  servers: PiMcpServerEntry[];
  /** The user-level mcp.json — where global writes land. */
  globalConfigPath: string;
  /** The project mcp.json when the project is trusted, else null. */
  projectConfigPath: string | null;
  projectTrusted: boolean;
  autoEnableCodemode: boolean;
  /** pi's own parse/validation errors for skipped entries. */
  errors: string[];
}

/** One mutation of the MCP configuration. */
export type PiMcpWriteParams =
  | { action: "add"; scope: "global" | "project"; name: string; config: Record<string, unknown> }
  | { action: "remove"; scope: "global" | "project"; name: string }
  /** Patch enabled/exposure in the file that defines or overrides the entry. */
  | { action: "patch"; name: string; enabled?: boolean; exposure?: string }
  /** Add a project override of a global server (enable/disable in this project). */
  | { action: "override"; name: string; enabled?: boolean; exposure?: string };

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
