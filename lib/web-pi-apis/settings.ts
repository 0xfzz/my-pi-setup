/**
 * `settings.read` / `settings.write` + `settings.models.read` / `settings.models.write`
 * — pi's SettingsManager, called natively.
 *
 * The web /settings and /scoped-models ports: pi's own settings surface,
 * read through `SettingsManager` (pi's public export) and written through
 * the SAME setter methods pi's TUI settings selector calls. The web never
 * defines a setting of its own; this whitelist is the TUI selector's
 * file-backed surface (session-level toggles — the live model, thinking,
 * per-session auto-compact — are other web ports, not settings).
 *
 * Writes go to the GLOBAL settings file (~/.pi/agent/settings.json), the
 * TUI selector's default scope: project-scope settings are trust-gated
 * (the /trust port) and stay a terminal surface. A written value reaches
 * the running TUI on its next restart or /reload, exactly like pi's own
 * `pi config` edits from another process.
 */
import type { PiSettingEntry } from "../../web/core/shared/pi-api.ts";
import type { PiApiContext, PiApiModule } from "./types.ts";

/** The manager shape this module uses — pi's SettingsManager, structural. */
interface SettingsManagerLike {
  getSettings(): Record<string, unknown>;
  getEnabledModels(): string[] | undefined;
  setEnabledModels(patterns: string[] | undefined): void;
  flush(): Promise<void>;
}

type JsonValue = string | number | boolean | null;

interface SettingSpec {
  key: string;
  label: string;
  description?: string;
  kind: "toggle" | "select" | "text" | "model";
  /** select entries: the offered choices; a custom current value joins them. */
  options?: Array<{ label: string; value: string | number | boolean }>;
  read: (manager: SettingsManagerLike) => JsonValue;
  write: (manager: SettingsManagerLike, value: JsonValue) => void;
}

const TRUE_FALSE = [
  { label: "true", value: true },
  { label: "false", value: false },
];

/** pi's thinking levels for the default-thinking select, pi's own order. */
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

const settings = (manager: SettingsManagerLike): Record<string, unknown> => manager.getSettings();

/** Narrow settings through a cast the type checker can verify per site. */
function managerAs<T>(manager: SettingsManagerLike): T {
  return manager as unknown as T;
}

const selectFrom = (
  key: string,
  label: string,
  description: string,
  values: Array<string | number | boolean>,
  setter: Setter,
): SettingSpec => ({
  key,
  label,
  description,
  kind: "select",
  options: values.map((value) => ({ label: String(value), value })),
  read: (manager) => {
    const current = settings(manager)[key];
    return typeof current === "string" || typeof current === "number" || typeof current === "boolean" ? current : null;
  },
  write: (manager, value) => setter(value),
});
type Setter = (value: JsonValue) => void;

const toggle = (key: string, label: string, description: string, setter: Setter): SettingSpec => ({
  key,
  label,
  description,
  kind: "toggle",
  options: TRUE_FALSE,
  read: (manager) => settings(manager)[key] === true,
  write: (manager, value) => setter(value),
});

const nestedToggle = (
  key: string,
  parent: string,
  label: string,
  description: string,
  setter: Setter,
): SettingSpec => ({
  key,
  label,
  description,
  kind: "toggle",
  options: TRUE_FALSE,
  read: (manager) => {
    const nested = settings(manager)[parent];
    return typeof nested === "object" && nested !== null
      ? (nested as Record<string, unknown>)[key] === true
      : false;
  },
  write: (manager, value) => setter(value),
});

/**
 * The settings surface — mirrors pi's SettingsSelectorComponent's file-backed
 * items. Values and option sets come from pi's own selector (transport,
 * share destination, idle-timeout choices, editor padding, …); the four
 * fullscreen-only items are included too — they configure the TUI's
 * fullscreen mode from wherever the setting is changed.
 */
function buildSpecs(manager: SettingsManagerLike): SettingSpec[] {
  return [
    {
      key: "defaultModel",
      label: "Default model",
      description: "Model for new sessions (provider/model)",
      kind: "model",
      read: (m) => {
        const provider = settings(m).defaultProvider;
        const model = settings(m).defaultModel;
        return typeof provider === "string" && typeof model === "string" ? `${provider}/${model}` : null;
      },
      write: (m, value) => {
        if (typeof value !== "string") throw new Error("defaultModel expects \"provider/model\"");
        const slash = value.indexOf("/");
        if (slash <= 0 || slash >= value.length - 1) throw new Error("defaultModel expects \"provider/model\"");
        managerAs<{ setDefaultModelAndProvider(provider: string, modelId: string): void }>(m).setDefaultModelAndProvider(
          value.slice(0, slash),
          value.slice(slash + 1),
        );
      },
    },
    selectFrom("defaultThinkingLevel", "Default thinking level", "Thinking level for new sessions", THINKING_LEVELS, (value) => {
      managerAs<{ setDefaultThinkingLevel(level: string): void }>(manager).setDefaultThinkingLevel(String(value));
    }),
    selectFrom(
      "steeringMode",
      "Steering mode",
      "Enter while streaming queues steering messages: 'one-at-a-time' delivers one then waits, 'all' delivers all at once",
      ["one-at-a-time", "all"],
      (value) => managerAs<{ setSteeringMode(mode: string): void }>(manager).setSteeringMode(String(value)),
    ),
    selectFrom(
      "followUpMode",
      "Follow-up mode",
      "Follow-up messages (sent while the agent runs): 'one-at-a-time' delivers one then waits, 'all' delivers all at once",
      ["one-at-a-time", "all"],
      (value) => managerAs<{ setFollowUpMode(mode: string): void }>(manager).setFollowUpMode(String(value)),
    ),
    selectFrom(
      "transport",
      "Transport",
      "Preferred transport for providers that support multiple transports",
      ["sse", "websocket", "websocket-cached", "auto"],
      (value) => managerAs<{ setTransport(transport: string): void }>(manager).setTransport(String(value)),
    ),
    selectFrom(
      "sessionShareDestination",
      "Session share destination",
      "Where /share uploads sessions (auto prefers Radius when authenticated, otherwise GitHub Gist)",
      ["auto", "gist", "radius"],
      (value) => managerAs<{ setSessionShareDestination(destination: string): void }>(manager).setSessionShareDestination(String(value)),
    ),
    selectFrom(
      "httpIdleTimeoutMs",
      "HTTP idle timeout",
      "Maximum idle gap while waiting for HTTP headers or body chunks; 0 disables",
      [30_000, 60_000, 120_000, 300_000, 0],
      (value) => managerAs<{ setHttpIdleTimeoutMs(timeoutMs: number): void }>(manager).setHttpIdleTimeoutMs(Number(value)),
    ),
    selectFrom(
      "cacheWarming",
      "Cache warming",
      "off; streaming warms while the agent runs; idle also between runs while continuation stays profitable",
      ["off", "streaming", "idle"],
      (value) => managerAs<{ setCacheWarmingMode(mode: string): void }>(manager).setCacheWarmingMode(String(value)),
    ),
    toggle(
      "compactionEnabled",
      "Auto-compact",
      "Compact context automatically when it grows too large (the file default; this session's toggle is separate)",
      (value) => managerAs<{ setCompactionEnabled(enabled: boolean): void }>(manager).setCompactionEnabled(value === true),
    ),
    toggle(
      "hideThinkingBlock",
      "Hide thinking",
      "Hide thinking blocks in assistant responses",
      (value) => managerAs<{ setHideThinkingBlock(hide: boolean): void }>(manager).setHideThinkingBlock(value === true),
    ),
    selectFrom(
      "markdown.mermaid",
      "Mermaid diagrams",
      "Render Mermaid code blocks as diagrams",
      ["off", "final", "streaming"],
      (value) => managerAs<{ setMermaidRenderingMode(mode: string): void }>(manager).setMermaidRenderingMode(String(value)),
    ),
    toggle(
      "showCacheMissNotices",
      "Cache miss notices",
      "Show transcript notices for cache costs and provider recovery diagnostics",
      (value) => managerAs<{ setShowCacheMissNotices(show: boolean): void }>(manager).setShowCacheMissNotices(value === true),
    ),
    toggle(
      "collapseChangelog",
      "Collapse changelog",
      "Show condensed changelog after updates",
      (value) => managerAs<{ setCollapseChangelog(collapse: boolean): void }>(manager).setCollapseChangelog(value === true),
    ),
    selectFrom(
      "quietStartup",
      "Quiet startup",
      "Disable verbose printing at startup ('header' keeps only the startup header)",
      [true, "header", false],
      (value) =>
        managerAs<{ setQuietStartup(quiet: boolean | string): void }>(manager).setQuietStartup(
          value === true ? true : value === "header" ? "header" : false,
        ),
    ),
    toggle(
      "enableInstallTelemetry",
      "Install telemetry",
      "Send an anonymous version/update ping after changelog-detected updates",
      (value) => managerAs<{ setEnableInstallTelemetry(enabled: boolean): void }>(manager).setEnableInstallTelemetry(value === true),
    ),
    selectFrom(
      "defaultProjectTrust",
      "Default project trust",
      "Fallback behavior when no extension or saved decision decides project trust",
      ["ask", "always", "never"],
      (value) => managerAs<{ setDefaultProjectTrust(trust: string): void }>(manager).setDefaultProjectTrust(String(value)),
    ),
    selectFrom(
      "doubleEscapeAction",
      "Double-escape action",
      "Action when pressing Escape twice with an empty editor",
      ["tree", "fork", "none"],
      (value) => managerAs<{ setDoubleEscapeAction(action: string): void }>(manager).setDoubleEscapeAction(String(value)),
    ),
    selectFrom(
      "treeFilterMode",
      "Tree filter mode",
      "Default filter when opening /tree",
      ["default", "no-tools", "user-only", "labeled-only", "all"],
      (value) => managerAs<{ setTreeFilterMode(mode: string): void }>(manager).setTreeFilterMode(String(value)),
    ),
    toggle(
      "showImages",
      "Show images",
      "Render images inline in the terminal (the TUI renderer; the web always shows them)",
      (value) => managerAs<{ setShowImages(show: boolean): void }>(manager).setShowImages(value === true),
    ),
    selectFrom(
      "imageWidthCells",
      "Image width",
      "Preferred inline image width in terminal cells",
      [60, 80, 120],
      (value) => managerAs<{ setImageWidthCells(width: number): void }>(manager).setImageWidthCells(Number(value)),
    ),
    nestedToggle(
      "autoResize",
      "images",
      "Auto-resize images",
      "Resize large images to 2000x2000 max for better model compatibility",
      (value) => managerAs<{ setImageAutoResize(enabled: boolean): void }>(manager).setImageAutoResize(value === true),
    ),
    nestedToggle(
      "blockImages",
      "images",
      "Block images",
      "Prevent images from being sent to LLM providers",
      (value) => managerAs<{ setBlockImages(blocked: boolean): void }>(manager).setBlockImages(value === true),
    ),
    toggle(
      "enableSkillCommands",
      "Skill commands",
      "Register skills as /skill:name commands",
      (value) => managerAs<{ setEnableSkillCommands(enabled: boolean): void }>(manager).setEnableSkillCommands(value === true),
    ),
    toggle(
      "showHardwareCursor",
      "Show hardware cursor",
      "Use the terminal cursor instead of pi's drawn cursor",
      (value) => managerAs<{ setShowHardwareCursor(enabled: boolean): void }>(manager).setShowHardwareCursor(value === true),
    ),
    selectFrom(
      "editorPaddingX",
      "Editor padding",
      "Horizontal padding for the TUI input editor",
      [0, 1, 2, 3],
      (value) => managerAs<{ setEditorPaddingX(padding: number): void }>(manager).setEditorPaddingX(Number(value)),
    ),
    selectFrom("outputPad", "Output padding", "Horizontal padding for messages, tool output and command output", [0, 1], (value) => {
      managerAs<{ setOutputPad(padding: 0 | 1): void }>(manager).setOutputPad(Number(value) === 1 ? 1 : 0);
    }),
    selectFrom(
      "autocompleteMaxVisible",
      "Autocomplete max items",
      "Max visible items in the TUI autocomplete dropdown",
      [3, 5, 7, 10, 15, 20],
      (value) => managerAs<{ setAutocompleteMaxVisible(maxVisible: number): void }>(manager).setAutocompleteMaxVisible(Number(value)),
    ),
    toggle(
      "clearOnShrink",
      "Clear on shrink",
      "Clear empty rows when content shrinks (may cause flicker)",
      (value) => managerAs<{ setClearOnShrink(enabled: boolean): void }>(manager).setClearOnShrink(value === true),
    ),
    toggle(
      "showTerminalProgress",
      "Terminal progress",
      "Show OSC 9;4 progress indicators in the terminal tab bar",
      (value) => managerAs<{ setShowTerminalProgress(enabled: boolean): void }>(manager).setShowTerminalProgress(value === true),
    ),
    selectFrom(
      "tuiMode",
      "TUI mode",
      "The terminal interface's layout mode",
      ["regular", "fullscreen"],
      (value) => managerAs<{ setTuiMode(mode: string): void }>(manager).setTuiMode(String(value)),
    ),
    selectFrom(
      "fullscreenExitOutput",
      "Fullscreen exit output",
      "What the TUI prints when leaving fullscreen mode",
      ["transcript", "resume-hint"],
      (value) => managerAs<{ setFullscreenExitOutput(output: string): void }>(manager).setFullscreenExitOutput(String(value)),
    ),
    selectFrom(
      "fullscreenScrollbar",
      "Fullscreen scrollbar",
      "Scrollbar behavior in fullscreen mode; no effect in regular mode",
      ["auto", "always", "hidden"],
      (value) => managerAs<{ setFullscreenScrollbar(mode: string): void }>(manager).setFullscreenScrollbar(String(value)),
    ),
    toggle(
      "fullscreenCopyOnSelect",
      "Fullscreen copy on select",
      "Automatically copy selected text in fullscreen mode",
      (value) => managerAs<{ setFullscreenCopyOnSelect(enabled: boolean): void }>(manager).setFullscreenCopyOnSelect(value === true),
    ),
    selectFrom(
      "fullscreenWheelScrollLines",
      "Fullscreen wheel scrolling",
      "Lines per mouse-wheel event in fullscreen mode; 'auto' speeds up fast wheel spins",
      ["auto", 1, 2, 3, 5, 10],
      (value) => {
        const lines = value === "auto" ? "auto" : Number(value);
        managerAs<{ setFullscreenWheelScrollLines(lines: number | string): void }>(manager).setFullscreenWheelScrollLines(lines);
      },
    ),
    nestedToggle(
      "anthropicExtraUsage",
      "warnings",
      "Anthropic extra-usage warning",
      "Warn about Anthropic extra-usage billing anomalies",
      (value) => {
        managerAs<{ setWarnings(warnings: Record<string, boolean>): void }>(manager).setWarnings({
          anthropicExtraUsage: value === true,
        });
      },
    ),
    {
      key: "theme",
      label: "Theme",
      description: "Color theme (the TUI's; the web keeps its own theme)",
      kind: "text",
      read: (m) => {
        const theme = settings(m).theme;
        return typeof theme === "string" ? theme : null;
      },
      write: (m, value) => {
        if (typeof value !== "string" || value.trim() === "") throw new Error("theme expects a name");
        managerAs<{ setTheme(theme: string): void }>(m).setTheme(value.trim());
      },
    },
    {
      key: "shellPath",
      label: "Shell path",
      description: "Shell used for the bash tool and `!` commands (empty: pi's default)",
      kind: "text",
      read: (m) => {
        const shell = settings(m).shellPath;
        return typeof shell === "string" ? shell : null;
      },
      write: (m, value) => {
        const path = typeof value === "string" ? value.trim() : "";
        managerAs<{ setShellPath(path: string | undefined): void }>(m).setShellPath(path === "" ? undefined : path);
      },
    },
  ];
}

/** pi's SettingsManager — the public export, one instance per request. */
async function loadManager(cwd: string): Promise<SettingsManagerLike> {
  const { SettingsManager, getAgentDir } = await import("@earendil-works/pi-coding-agent");
  return SettingsManager.create(cwd, getAgentDir()) as unknown as SettingsManagerLike;
}

function entryOf(spec: SettingSpec, manager: SettingsManagerLike): PiSettingEntry {
  const value = spec.read(manager);
  let options = spec.options;
  // A custom current value (a preset-less number, an off-list theme) joins
  // the choices so it stays representable.
  if (value !== null && options !== undefined && !options.some((option) => option.value === value)) {
    options = [...options, { label: String(value), value }];
  }
  return {
    key: spec.key,
    label: spec.label,
    ...(spec.description !== undefined ? { description: spec.description } : {}),
    kind: spec.kind,
    value,
    ...(options !== undefined ? { options } : {}),
  };
}

/** Value validation per kind — a write must match its read's shape. */
function writeValue(spec: SettingSpec, value: JsonValue): JsonValue {
  if (spec.kind === "toggle") {
    if (typeof value !== "boolean") throw new Error(`${spec.key} expects true or false`);
    return value;
  }
  if (spec.kind === "model" || spec.kind === "text") {
    if (typeof value !== "string") throw new Error(`${spec.key} expects a string`);
    return value;
  }
  // select: whatever the spec's setter accepts (validated there).
  return value;
}

/** `settings.read` — the effective settings as the TUI selector shows them. */
export const settingsApi: PiApiModule = {
  api: "settings.read",

  async handle(_params: unknown, ctx: PiApiContext): Promise<unknown> {
    const manager = await loadManager(ctx.cwd);
    return { settings: buildSpecs(manager).map((spec) => entryOf(spec, manager)) };
  },
};

/** `settings.write` — one setting through pi's own setter, then flush. */
export const settingsWriteApi: PiApiModule = {
  api: "settings.write",

  async handle(params: unknown, ctx: PiApiContext): Promise<unknown> {
    const { key, value } = (params as { key?: unknown; value?: unknown } | null ?? {}) as {
      key?: unknown;
      value?: unknown;
    };
    if (typeof key !== "string" || key === "") throw new Error("params: {key: string, value: …}");
    if (value !== null && typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error("value must be a string, number, boolean or null");
    }
    const manager = await loadManager(ctx.cwd);
    const spec = buildSpecs(manager).find((candidate) => candidate.key === key);
    if (spec === undefined) throw new Error(`unknown setting: ${key}`);
    spec.write(manager, writeValue(spec, value));
    await manager.flush();
    return { key, value: spec.read(manager) };
  },
};

/**
 * `settings.models.read` / `settings.models.write` — /scoped-models' persist
 * surface: the raw `enabledModels` patterns (null = every available model,
 * pi's unscoped default) written through pi's setEnabledModels — the exact
 * call the TUI's /scoped-models persist path makes. The pattern list is
 * offered to the client with the session's available models; a pattern may
 * be a bare model id that matches nothing yet (pi keeps it as a diagnostic).
 */
export const settingsModelsApi: PiApiModule = {
  api: "settings.models.read",

  async handle(_params: unknown, ctx: PiApiContext): Promise<unknown> {
    const manager = await loadManager(ctx.cwd);
    const enabled = manager.getEnabledModels();
    return { enabled: enabled === undefined ? null : [...enabled] };
  },
};

export const settingsModelsWriteApi: PiApiModule = {
  api: "settings.models.write",

  async handle(params: unknown, ctx: PiApiContext): Promise<unknown> {
    const { patterns } = (params as { patterns?: unknown } | null ?? {}) as { patterns?: unknown };
    if (patterns !== null && !Array.isArray(patterns)) {
      throw new Error("params: {patterns: string[] | null}");
    }
    if (patterns !== null && !patterns.every((pattern) => typeof pattern === "string" && pattern.trim() !== "")) {
      throw new Error("patterns must be non-empty strings");
    }
    const manager = await loadManager(ctx.cwd);
    manager.setEnabledModels(patterns === null ? undefined : (patterns as string[]));
    await manager.flush();
    const enabled = manager.getEnabledModels();
    return { enabled: enabled === undefined ? null : [...enabled] };
  },
};
