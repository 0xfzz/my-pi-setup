import type { ExtensionUIContext, ExtensionWidgetOptions } from "@earendil-works/pi-coding-agent";
import {
  publishWebUi,
  type PublishWebViewTarget,
} from "../plugin-contracts/publisher.ts";
import type { WebUiPayloads, WebUiType } from "../plugin-contracts/ui-event-models.ts";
import {
  publishUiAutocompleteProvider,
  publishUiEditorComponent,
  publishUiFooter,
  publishUiHeader,
  type BridgePublishTarget,
} from "../protocol/publisher.ts";

type UiEvents = NonNullable<BridgePublishTarget["events"]>;

export interface HeadlessWebUiContextOptions {
  /**
   * Session event bus. Without one the context stays a safe no-op, matching
   * the runner's own headless UI context.
   */
  events?: BridgePublishTarget["events"];
  /**
   * Explicit attribution. Pi hands every extension the same UI context, so
   * the context cannot infer which extension called it; the host must name
   * the producer when it knows it.
   */
  sourceId?: string;
}

const DEFAULT_SOURCE_ID = "ctx.ui";
const MAX_LABEL_CHARS = 160;
const MAX_WIDGET_LINES = 200;
const MAX_LINE_CHARS = 8192;

function componentLabel(factory: unknown, fallback: string): string {
  if (factory === undefined) return "";
  if (typeof factory !== "function") return fallback;
  const name = factory.name;
  return name === "" || name === "anonymous" ? fallback : name.slice(0, MAX_LABEL_CHARS);
}

function widgetLines(content: unknown): string[] | null {
  if (!Array.isArray(content)) return null;
  const lines = content
    .filter((line): line is string => typeof line === "string")
    .slice(0, MAX_WIDGET_LINES)
    .map((line) => line.slice(0, MAX_LINE_CHARS));
  return lines.length === 0 ? null : lines;
}

function emitState<K extends WebUiType>(events: UiEvents, sourceId: string, type: K, payload: WebUiPayloads[K]): void {
  const target: PublishWebViewTarget = { events };
  publishWebUi(target, sourceId, type, payload);
}

/**
 * A headless UI context for the web server's in-process sessions.
 *
 * The web UI is a separate surface: extension *views* reach it through the
 * session bus (publishWebView -> WEB_PLUGIN_VIEW_EVENT), not through
 * `ctx.ui`. Providing a real UI context flips `hasUI` to true so the web view
 * publishes run on `session_start`. Calls that only draw in a terminal become
 * WEB_UI_EVENT/protocol envelopes when a bus and producer id are supplied, so
 * an extension that never imported web code is still visible through the
 * bridge. Other methods stay no-ops; publishing them would duplicate the
 * values cooperating extensions already send with `publishWebUi`.
 */
export function createHeadlessWebUiContext(options: HeadlessWebUiContextOptions = {}): ExtensionUIContext {
  const events = options.events;
  const sourceId = options.sourceId === undefined || options.sourceId === "" ? DEFAULT_SOURCE_ID : options.sourceId;
  const theme = {
    fg: (_token: string, value: string) => value,
    bg: (_token: string, value: string) => value,
  };
  const state = <K extends WebUiType>(type: K, payload: WebUiPayloads[K]): void => {
    if (events !== undefined) emitState(events, sourceId, type, payload);
  };
  const envelope = (publish: (target: BridgePublishTarget, id: string, messageId: string) => void, messageId: string): void => {
    if (events !== undefined) publish({ events }, sourceId, messageId);
  };
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: (key: string, text: string | undefined) => state("ui.status.changed", { key, text: text ?? null }),
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: (key: string, content: unknown, widgetOptions?: ExtensionWidgetOptions) => state("ui.widget.changed", {
      key,
      lines: widgetLines(content),
      placement: widgetOptions?.placement ?? "aboveEditor",
    }),
    setFooter: (factory: unknown) => envelope(
      (target, id, messageId) => { publishUiFooter(target, id, componentLabel(factory, "footer"), messageId); },
      `${sourceId}:setFooter`,
    ),
    setHeader: (factory: unknown) => envelope(
      (target, id, messageId) => { publishUiHeader(target, id, componentLabel(factory, "header"), messageId); },
      `${sourceId}:setHeader`,
    ),
    setTitle: (title: string) => state("ui.title.changed", { text: title }),
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: (factory: unknown) => envelope(
      (target, id, messageId) => {
        publishUiAutocompleteProvider(target, id, componentLabel(factory, "autocomplete provider"), messageId);
      },
      `${sourceId}:addAutocompleteProvider`,
    ),
    setEditorComponent: (factory: unknown) => envelope(
      (target, id, messageId) => {
        publishUiEditorComponent(target, id, componentLabel(factory, "editor component"), messageId);
      },
      `${sourceId}:setEditorComponent`,
    ),
    getEditorComponent: () => undefined,
    // A terminal-theme stub: headless sessions have no colors. Kept non-null so
    // extensions that read `ctx.ui.theme.fg/bg` (only TUI-only paths today) do
    // not throw if they ever run in a non-TUI mode.
    theme,
    getAllThemes: () => [],
    getTheme: () => undefined,
    setTheme: () => ({ success: false, error: "no terminal theme in the web server" }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  } as unknown as ExtensionUIContext;
}
