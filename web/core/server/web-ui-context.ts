import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";

/**
 * A headless UI context for the web server's in-process sessions.
 *
 * The web UI is a separate surface: extension *views* reach it through the
 * session bus (publishWebView -> WEB_PLUGIN_VIEW_EVENT), not through
 * `ctx.ui`. But several extensions gate those publishes behind `ctx.hasUI`,
 * which the runner derives from whether a UI context is present. Providing a
 * real (no-op) UI context flips `hasUI` to true so the web view publishes run
 * on `session_start`, while the TUI-only `ctx.ui` methods stay safe no-ops.
 *
 * The web store receives widgets/statuses/notifications through the session
 * bus (WEB_UI_EVENT), never through this object — those surfaces are driven by
 * `publishWebUi`, and the TUI drawing calls in these methods are irrelevant to
 * a headless session. Making every method a safe no-op (rather than throwing)
 * mirrors the runner's own `noOpUIContext`, which is exactly what the web host
 * used before it requested a real context.
 */
export function createHeadlessWebUiContext(): ExtensionUIContext {
  const theme = {
    fg: (_token: string, value: string) => value,
    bg: (_token: string, value: string) => value,
  };
  return {
    select: async () => undefined,
    confirm: async () => false,
    input: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWorkingVisible: () => {},
    setWorkingIndicator: () => {},
    setHiddenThinkingLabel: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined as never,
    pasteToEditor: () => {},
    setEditorText: () => {},
    getEditorText: () => "",
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
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