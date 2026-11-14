/**
 * Extension-point catalog: the logic seams a plugin may attach to.
 *
 * These ids are the kernel's public API — `hooks.ts` and `services.ts` validate
 * against them, so a plugin cannot hook a point the host never calls. Every
 * entry here has a named call site in `web/core/server/` (or a plugin's own
 * server half, for `file.before-read`); a point with no call site is not listed,
 * because a catalogued point that nothing invokes is a promise the host breaks.
 *
 * The UI vocabulary is a different axis with its own single source:
 * `WEB_UI_ANCHORS` / `WEB_UI_COMPONENTS` / `OVERRIDABLE_COMPONENTS` in
 * `ui-contracts.ts`, which the descriptor validator enforces. Both are
 * documented together in docs/web-plugin-catalog.md.
 */
import { TAP_CHANNELS, type TapChannel } from "./events.ts";
import { OVERRIDABLE_COMPONENTS, WEB_UI_ANCHORS, WEB_UI_COMPONENTS, WEB_UI_REGIONS } from "../ui-contracts.ts";

export const POINT_KINDS = ["event", "waterfall", "bail", "service", "protected"] as const;

export type PointKind = (typeof POINT_KINDS)[number];

export type Stability = "stable" | "experimental";

export interface ExtensionPoint {
  /** Dotted id, or `service:<name>` for a resolvable implementation. */
  id: string;
  kind: PointKind;
  version: number;
  stability: Stability;
  protected: boolean;
  description: string;
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
  // Observe: fire-and-forget, cannot change the result.
  point("session.created", "event", "A hosted session was created."),
  point("session.settled", "event", "A hosted session finished a turn."),
  point("message.appended", "event", "A message was appended to a session."),
  point("tool.finished", "event", "A tool call finished."),
  point("plugin.enabled", "event", "A plugin was enabled."),

  // Transform: each handler receives the previous value and returns the next.
  point("prompt.before-send", "waterfall", "Transform the prompt before it is sent to the agent.", { stability: "stable" }),
  point("attachment.before-upload", "waterfall", "Transform an attachment before it is stored."),
  point("message.before-render-model", "waterfall", "Transform a message before it is rendered."),
  point("session.list.sort", "waterfall", "Reorder the session list."),

  // Veto: the first handler to return `{ deny }` stops the action.
  point("session.before-delete", "bail", "Veto deleting a session with a user-visible reason.", { stability: "stable" }),
  point("file.before-read", "bail", "Veto reading a file through the Files plugin."),

  // Services: a named implementation the host resolves at call time.
  point("service:session.search", "service", "Session search over the live and on-disk list."),
  point("service:model.pick", "service", "The model catalog a session offers."),

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

export function lookupPoint(ref: string): LookupResult {
  const { id, version } = splitRef(ref);
  const found = EXTENSION_POINTS.find((candidate) => candidate.id === id);
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
  return EXTENSION_POINTS.filter((candidate) => candidate.stability === "stable");
}

/** The tap vocabulary, described once here and documented from `TAP_CHANNELS`. */
const TAP_CHANNEL_DESCRIPTIONS: Record<TapChannel, string> = {
  "session.lifecycle": "A live session started a turn, settled, shut down, or was renamed.",
  "session.message": "A message was appended to a live session: role, block types, capped text.",
  "session.tool": "A tool call started or finished, or a bash execution completed.",
};

function tapRows(): string[] {
  return TAP_CHANNELS.map((channel) => `| \`${channel}\` | \`tap.pi-events:${channel}\` | ${TAP_CHANNEL_DESCRIPTIONS[channel]} |`);
}

const LOGIC_TABLE_HEADER = ["| Id | Kind | Stability | Description |", "| --- | --- | --- | --- |"];

function logicRows(points: readonly ExtensionPoint[]): string[] {
  return points.map((candidate) =>
    `| \`${candidate.id}@${candidate.version}\` | ${candidate.kind} | ${candidate.stability}${candidate.protected ? ", protected" : ""} | ${candidate.description} |`);
}

function uiRows(): string[] {
  return [
    ...WEB_UI_ANCHORS.map((anchor) => `| \`${anchor}\` | anchor | Where a view may mount. |`),
    ...WEB_UI_REGIONS.map((region) => `| \`${region}\` | region | A slot the host renders. |`),
    ...Object.entries(WEB_UI_COMPONENTS).map(([id, entry]) =>
      `| \`${id}\` | component | ${entry.model} model${OVERRIDABLE_COMPONENTS.includes(id as never) ? "; overridable" : ""} |`),
  ];
}

/** The generated catalog doc: logic points, then the UI vocabulary. */
export function catalogMarkdown(points: readonly ExtensionPoint[] = EXTENSION_POINTS): string {
  return [
    "# Web plugin extension-point catalog",
    "",
    "> Part of [pi-workflow-extensions](../README.md). Every extension point a web plugin can use, with its stability, version and whether it is protected. Web plugins are interface bridging — the boundary rule lives in [web-plugin-architecture.md](web-plugin-architecture.md).",
    "",
    "Generated by `scripts/gen-web-plugin-catalog.mjs`. Do not edit by hand.",
    "",
    "## Logic points",
    "",
    "Hook and service ids the kernel validates against. Each one has a named call site in the host, so attaching to it does something.",
    "",
    ...LOGIC_TABLE_HEADER,
    ...logicRows(points),
    "",
    "## Tap channels",
    "",
    "`ctx.events.on(channel, handler)` subscribes to live session activity. Each channel needs its own grant; a bare `tap.pi-events` grant covers every channel. Delivery is budgeted, isolated per subscriber, and ordered; the payload is the host's bounded projection, never the raw pi event.",
    "",
    "| Channel | Grant | Carries |",
    "| --- | --- | --- |",
    ...tapRows(),
    "",
    "## UI vocabulary",
    "",
    "Where a plugin's views may mount, from `web/core/plugin-contracts/ui-contracts.ts`. A descriptor is validated against these lists; the host mounts every entry.",
    "",
    "| Id | Kind | Notes |",
    "| --- | --- | --- |",
    ...uiRows(),
    "",
  ].join("\n");
}
