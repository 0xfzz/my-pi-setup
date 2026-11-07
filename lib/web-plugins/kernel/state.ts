/**
 * Operator state persisted in `web-plugins.json` (PRD R20, §6.5): enablement,
 * granted capabilities, quarantine clears, recent boot times for the crash-loop
 * guard, and the plugins that were mid-activation when the process last died.
 *
 * A missing or corrupt file never stops the app: it loads as the default state
 * and the reason is returned so the manager can audit it.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const STATE_VERSION = 1;
export const SAFE_MODE_CRASH_LIMIT = 2;
export const SAFE_MODE_WINDOW_MS = 60_000;
/** Boot times kept for the crash-loop window; older entries are pointless. */
const BOOT_HISTORY_LIMIT = 20;

export interface PluginOperatorState {
  enabled: boolean;
  /** Capability strings the operator has confirmed, e.g. `ui.replace:chat.message.*`. */
  grants: string[];
  /** Set when the operator clears a quarantine; the breaker starts fresh from here. */
  quarantineClearedAt?: number;
  /** Persisted quarantine: survives restarts until cleared or the plugin version changes. */
  quarantine?: { version: string; reason: string; at: number };
}

export interface WebPluginsState {
  version: typeof STATE_VERSION;
  plugins: Record<string, PluginOperatorState>;
  /** Epoch ms of recent process starts, oldest first. */
  boots: number[];
  /** Plugin ids that were `activating` when the last process stopped. */
  activating: string[];
}

export type LoadResult = { state: WebPluginsState; warning?: string };

export function defaultState(): WebPluginsState {
  return { version: STATE_VERSION, plugins: {}, boots: [], activating: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validate untrusted JSON into a state object. Returns a reason when it is not usable. */
export function parseState(input: unknown): { ok: true; state: WebPluginsState } | { ok: false; error: string } {
  if (!isRecord(input)) return { ok: false, error: "state must be a JSON object" };
  if (input.version !== STATE_VERSION) return { ok: false, error: `unsupported state version ${String(input.version)}` };
  if (!isRecord(input.plugins)) return { ok: false, error: "plugins must be an object" };
  const plugins: Record<string, PluginOperatorState> = {};
  for (const [id, entry] of Object.entries(input.plugins)) {
    if (!isRecord(entry) || typeof entry.enabled !== "boolean" || !Array.isArray(entry.grants) || !entry.grants.every((g) => typeof g === "string")) {
      return { ok: false, error: `plugins["${id}"] is malformed` };
    }
    const q = entry.quarantine;
    const quarantine = isRecord(q) && typeof q.version === "string" && typeof q.reason === "string" && typeof q.at === "number"
      ? { version: q.version, reason: q.reason, at: q.at }
      : undefined;
    plugins[id] = {
      enabled: entry.enabled,
      grants: [...entry.grants],
      ...(typeof entry.quarantineClearedAt === "number" ? { quarantineClearedAt: entry.quarantineClearedAt } : {}),
      ...(quarantine ? { quarantine } : {}),
    };
  }
  const boots = Array.isArray(input.boots) ? input.boots.filter((n): n is number => typeof n === "number" && Number.isFinite(n)) : [];
  const activating = Array.isArray(input.activating) ? input.activating.filter((id): id is string => typeof id === "string") : [];
  return { ok: true, state: { version: STATE_VERSION, plugins, boots: boots.slice(-BOOT_HISTORY_LIMIT), activating } };
}

export function loadState(path: string): LoadResult {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { state: defaultState() };
    return { state: defaultState(), warning: `could not read ${path}: ${String(error)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { state: defaultState(), warning: `${path} is not valid JSON; using defaults (${String(error)})` };
  }
  const result = parseState(parsed);
  if (!result.ok) return { state: defaultState(), warning: `${path} rejected; using defaults (${result.error})` };
  return { state: result.state };
}

/** Atomic write: a temp file in the same directory, then rename, so a crash never leaves half a file. */
export function saveState(path: string, state: WebPluginsState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tmp, path);
}

/**
 * Record a process start and decide whether to boot in safe mode. An explicit
 * `PI_WEB_SAFE_MODE=1` always wins; otherwise two starts inside the window trip it.
 */
export function recordBoot(
  state: WebPluginsState,
  now: number,
  env: Record<string, string | undefined> = {},
): { state: WebPluginsState; safeMode: boolean; reason?: string } {
  const boots = [...state.boots, now].slice(-BOOT_HISTORY_LIMIT);
  const next: WebPluginsState = { ...state, boots };
  if (env.PI_WEB_SAFE_MODE === "1") return { state: next, safeMode: true, reason: "PI_WEB_SAFE_MODE=1" };
  const recent = boots.filter((at) => at > now - SAFE_MODE_WINDOW_MS);
  if (recent.length >= SAFE_MODE_CRASH_LIMIT) {
    return {
      state: next,
      safeMode: true,
      reason: `${recent.length} starts within ${SAFE_MODE_WINDOW_MS / 1000}s`,
    };
  }
  return { state: next, safeMode: false };
}

/**
 * A plugin still marked `activating` from the previous process died mid-activation.
 * Returns the ids to mark `failed` and the state with that marker cleared.
 */
export function recoverInterruptedActivation(state: WebPluginsState): { crashed: string[]; state: WebPluginsState } {
  return { crashed: [...state.activating], state: { ...state, activating: [] } };
}

/** Persist that these plugins have begun activating; cleared once they settle. */
export function markActivating(state: WebPluginsState, ids: readonly string[]): WebPluginsState {
  return { ...state, activating: [...new Set(ids)].sort() };
}

export function setPluginState(state: WebPluginsState, id: string, patch: Partial<PluginOperatorState>): WebPluginsState {
  const current = state.plugins[id] ?? { enabled: false, grants: [] };
  return { ...state, plugins: { ...state.plugins, [id]: { ...current, ...patch } } };
}
