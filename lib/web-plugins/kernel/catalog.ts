/**
 * Extension-point catalog (PRD §5.4). Ids are the public API: the registries
 * reject any contribution whose point is not listed here, unless a plugin
 * defines it under its own namespace. `protected` points can never be
 * replaced, wrapped or vetoed by a plugin.
 */

export const POINT_KINDS = [
  "slot",
  "component",
  "route",
  "command",
  "keybinding",
  "theme",
  "event",
  "waterfall",
  "bail",
  "service",
  "job",
  "storage",
  "bridge",
  "tap",
  "protected",
] as const;

export type PointKind = (typeof POINT_KINDS)[number];

export type Stability = "stable" | "experimental";

export interface ExtensionPoint {
  /** Dotted id. A trailing `<name>` placeholder marks a family (e.g. `chat.tool.<name>`). */
  id: string;
  kind: PointKind;
  version: number;
  stability: Stability;
  protected: boolean;
  description: string;
  /** The `WEB_UI_COMPONENTS` key this point replaces, when one exists today. */
  legacyComponent?: string;
}

const point = (
  id: string,
  kind: PointKind,
  description: string,
  extra: Partial<Omit<ExtensionPoint, "id" | "kind" | "description">> = {},
): ExtensionPoint => ({
  id,
  kind,
  version: 1,
  stability: "experimental",
  protected: false,
  description,
  ...extra,
});

export const EXTENSION_POINTS: readonly ExtensionPoint[] = [
  // UI slots: additive regions. A slot contribution never controls its host's layout.
  point("app.header", "slot", "Application header, right of the title."),
  point("session.header", "slot", "Header of the selected session."),
  point("session.sidebar.row.actions", "slot", "Action area of a sidebar session row."),
  point("chat.before", "slot", "Above the message list.", { legacyComponent: "ui.chat-before.v1" }),
  point("chat.composer.toolbar", "slot", "Toolbar beside the composer's attach button."),
  point("chat.composer.above", "slot", "Strip above the composer."),
  point("file-panel.header", "slot", "Header of the file panel."),
  point("settings.sections", "slot", "Sections of the settings page."),

  // UI components: replaceable by key, with a built-in `Default`.
  point("chat.message.user", "component", "A user message row."),
  point("chat.message.assistant", "component", "An assistant message row."),
  point("chat.tool.<name>", "component", "A tool call, keyed by tool name."),
  point("chat.tool.result.<name>", "component", "A tool result, keyed by tool name."),
  point("chat.working", "component", "The working indicator under the message list.", {
    legacyComponent: "ui.working-indicator.v1",
  }),
  point("chat.input", "component", "The chat input."),
  point("sidebar.session-row", "component", "A sidebar session row.", {
    legacyComponent: "ui.session-sidebar-row.v1",
  }),
  point("file.viewer.<mime>", "component", "The file viewer for a MIME type."),
  point("settings.panel.<id>", "component", "A settings panel."),
  point("ui.extension-status", "component", "Extension status chip.", {
    legacyComponent: "ui.extension-status.v1",
  }),
  point("ui.plugin-view", "component", "Declarative plugin view renderer.", {
    legacyComponent: "ui.plugin-view.v1",
  }),
  point("ui.floating-layer", "component", "Floating overlay layer.", {
    legacyComponent: "ui.floating-layer.v1",
  }),

  // Routes, commands and keys.
  point("route.page", "route", "A plugin page under /p/<plugin-id>/…"),
  point("command", "command", "A palette command, optionally a slash command."),
  point("keybinding", "keybinding", "A keyboard shortcut, checked for conflicts with the core map."),
  point("theme", "theme", "A validated design-token theme."),

  // Logic: observe, transform, veto.
  point("session.created", "event", "A hosted session was created."),
  point("session.settled", "event", "A hosted session finished a turn."),
  point("message.appended", "event", "A message was appended to a session."),
  point("tool.finished", "event", "A tool call finished."),
  point("plugin.enabled", "event", "A plugin was enabled."),
  point("prompt.before-send", "waterfall", "Transform the prompt before it is sent to the agent.", {
    stability: "stable",
  }),
  point("message.before-render-model", "waterfall", "Transform a message before it is rendered."),
  point("session.list.sort", "waterfall", "Reorder the session list."),
  point("session.title.generate", "waterfall", "Produce a session title."),
  point("session.before-delete", "bail", "Veto deleting a session with a user-visible reason.", {
    stability: "stable",
  }),
  point("file.before-read", "bail", "Veto reading a file."),
  point("attachment.before-upload", "waterfall", "Transform an attachment before upload."),

  // Services: named, replaceable implementations.
  point("service:session.search", "service", "Session search."),
  point("service:model.pick", "service", "Model selection."),
  point("service:notifier", "service", "User notifications."),
  point("service:title-generator", "service", "Session title generation."),

  // Background work, storage, bridge, pi-event tap.
  point("job.schedule", "job", "A scheduled or event-triggered background job."),
  point("storage.scope", "storage", "Scoped key-value storage: global, project, or session."),
  point("bridge.call", "bridge", "A typed browser-to-server call owned by a plugin."),
  point("tap.pi-events", "tap", "Read-only projection of a session's pi event stream."),

  // Protected: observable at most, never replaceable, vetoable, or skippable.
  point("core.auth.session", "protected", "Signed-session authentication and proxy.", { protected: true, stability: "stable" }),
  point("core.transport", "protected", "SSE transport integrity and loopback binding.", { protected: true, stability: "stable" }),
  point("core.plugin-manager", "protected", "Plugin manager and safe-mode entry.", { protected: true, stability: "stable" }),
  point("core.capability-gate", "protected", "The capability gate and the audit log.", { protected: true, stability: "stable" }),
  point("core.confirm.destructive", "protected", "Destructive-action confirmation dialogs (add, never skip).", { protected: true, stability: "stable" }),
];

export type LookupResult =
  | { ok: true; point: ExtensionPoint; version: number }
  | { ok: false; error: string };

/** Split `id@version`; the version defaults to the point's current version. */
function splitRef(ref: string): { id: string; version?: number } {
  const at = ref.lastIndexOf("@");
  if (at === -1) return { id: ref };
  return { id: ref.slice(0, at), version: Number(ref.slice(at + 1)) };
}

/** Matches a concrete id against a catalogued id, treating `<name>` as a one-segment wildcard. */
function matchesFamily(catalogued: string, concrete: string): boolean {
  if (!catalogued.includes("<")) return catalogued === concrete;
  const pattern = catalogued
    .split(/<[a-z-]+>/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^.]+");
  return new RegExp(`^${pattern}$`).test(concrete);
}

export function lookupPoint(ref: string): LookupResult {
  const { id, version } = splitRef(ref);
  const found = EXTENSION_POINTS.find((p) => matchesFamily(p.id, id));
  if (!found) return { ok: false, error: `unknown extension point "${id}"` };
  if (version !== undefined && version !== found.version) {
    return { ok: false, error: `extension point "${id}" is version ${found.version}; "@${version}" is not served` };
  }
  return { ok: true, point: found, version: found.version };
}

export function isProtectedPoint(ref: string): boolean {
  const result = lookupPoint(ref);
  return result.ok && result.point.protected;
}

/** Stable ids a plugin may rely on without an experimental opt-in. */
export function stablePoints(): readonly ExtensionPoint[] {
  return EXTENSION_POINTS.filter((p) => p.stability === "stable");
}

export function catalogMarkdown(points: readonly ExtensionPoint[] = EXTENSION_POINTS): string {
  const rows = points.map((p) =>
    `| \`${p.id}@${p.version}\` | ${p.kind} | ${p.stability}${p.protected ? ", protected" : ""} | ${p.description}${p.legacyComponent ? ` (was \`${p.legacyComponent}\`)` : ""} |`);
  return [
    "# Web plugin extension-point catalog",
    "",
    "Generated from `lib/web-plugins/kernel/catalog.ts` by `scripts/gen-web-plugin-catalog.mjs`. Do not edit by hand.",
    "",
    "| Id | Kind | Stability | Description |",
    "| --- | --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}
