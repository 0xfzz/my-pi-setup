/**
 * Shared vocabulary for the access-scope gate.
 *
 * The model is deliberately copied from opencode's permission system: an action
 * resolves to one of three effects, rules are glob patterns evaluated
 * last-match-wins, and "outside the workspace" is its own action so a boundary
 * escape can never be approved implicitly by a `read: allow` rule.
 *
 * Kept free of imports so the policy core stays testable without a Pi session.
 */

/** What should happen. `ask` is the safe default and never means "yes". */
export type ScopeEffect = "allow" | "ask" | "deny";

/** Read or write access for a root. Writes also cover shell mutations. */
export type ScopeAccess = "ro" | "rw";

export type ScopeGrantSource = "session" | "branch" | "project" | "global" | "config";

export interface ScopeRoot {
  /** Absolute, canonical path. Never `~`: expansion happens on input. */
  path: string;
  access: ScopeAccess;
  source: ScopeGrantSource;
}

export interface ScopeRule {
  /** Tool name, or `*` for every action. */
  action: string;
  /** Resource glob: workspace-relative with `/`, or absolute for external paths. */
  resource: string;
  effect: ScopeEffect;
  source?: ScopeGrantSource;
}

/**
 * `external` covers paths outside every root; `unknown` covers a tool whose
 * inputs this extension cannot map to a path. Both default to `ask`.
 */
export interface ScopeDefaults {
  /** Writes outside every root. */
  external: ScopeEffect;
  /**
   * Reads outside every root. Open by default.
   *
   * Every harness surveyed (Claude Code, Codex CLI, Cline) gates *writes*: reads
   * are allowed in the workspace and, for the most part, on the machine, because
   * refusing `cat /etc/os-release` protects nothing and makes the gate noisy
   * enough that people turn it off. Writes outside the workspace still ask.
   */
  readExternal: ScopeEffect;
  /** Tools whose paths cannot be mapped at all (an unmapped MCP server). */
  unknown: ScopeEffect;
}

export interface ScopeState {
  roots: readonly ScopeRoot[];
  rules: readonly ScopeRule[];
  defaults: ScopeDefaults;
  /** `/scope yolo`. `undefined` means disarmed. */
  yolo?: ScopeYolo;
}

export interface ScopeYolo {
  /** `ro` auto-approves reads only; `rw` also auto-approves writes. */
  strength: ScopeAccess;
  /** Whether the arm survives reload/resume (a branch record). */
  persist: boolean;
  since: number;
}

/** One tool call's path claim, produced by `tool-paths.ts`. */
export interface PathClaim {
  tool: string;
  /** Rule action: the tool name, or `external_directory` for a boundary escape. */
  action: string;
  /** Absolute path the tool will touch. */
  absolute: string;
  /** Workspace-relative resource for internal paths; absolute for external. */
  resource: string;
  /** `true` when the call can modify the target. */
  write: boolean;
  external: boolean;
  /** Set when the claim is a directory (grants widen to the directory). */
  kind: "file" | "directory" | "unknown";
}

/** A tool call with no mapable path (a new MCP server, a dispatcher). */
export interface UnknownClaim {
  tool: string;
  unknown: true;
}

export type Claim = PathClaim | UnknownClaim;

export interface ScopeDecision {
  effect: ScopeEffect;
  /** One line shown in the dialog or fed back to the model when blocked. */
  reason: string;
  /** The resource the decision was made for; `*` for unknown tools. */
  resource: string;
  external: boolean;
  write: boolean;
  /** Rule that produced the decision, when a rule matched. */
  rule?: ScopeRule;
  /** Root that allowed the decision, when a root covered it. */
  root?: ScopeRoot;
}

/** The "allow this folder" offer shown by the dialog and used by `/scope allow`. */
export interface ScopeSuggestion {
  /** Directory to add as a root. May equal the file itself for a single-file grant. */
  path: string;
  access: ScopeAccess;
  /** Literal glob that will be stored, so widening is never implicit. */
  glob: string;
  /** True when the suggestion is one file and no directory grant is offered. */
  exact: boolean;
}

/** Branch record written by `/scope allow` and `yolo --persist`. */
export interface ScopeRecord {
  roots?: Array<{ path: string; access: ScopeAccess }>;
  rules?: ScopeRule[];
  yolo?: { strength: ScopeAccess } | null;
  /** Monotonic sequence so the last record wins on a branch. */
  seq?: number;
}

export const SCOPE_RECORD_TYPE = "agent-scope:v1";

export const DEFAULT_SCOPE_DEFAULTS: ScopeDefaults = { external: "ask", readExternal: "allow", unknown: "ask" };

/** Directories that must never become a standing grant from a dialog answer. */
export function isUnsafeRoot(path: string, home: string | undefined): boolean {
  if (path === "/" || path === "") return true;
  if (home && path === home) return true;
  // A Windows drive root such as `C:\`.
  if (/^[A-Za-z]:[\\/]?$/.test(path)) return true;
  // System trees: a "yes" here would hand over every accounts file, binary and
  // service definition on the machine from one dialog answer.
  return SYSTEM_ROOTS.has(path.replace(/\\/g, "/"));
}

const SYSTEM_ROOTS: ReadonlySet<string> = new Set([
  "/etc", "/usr", "/bin", "/sbin", "/boot", "/dev", "/proc", "/sys", "/var", "/opt", "/root", "/home",
]);
