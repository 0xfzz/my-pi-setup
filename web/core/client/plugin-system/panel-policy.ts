import type { WebPluginDescriptor, WebView } from "./contract.ts";

/**
 * A plugin has a right-hand panel when it declares a `sidebar` surface.
 *
 * A slot placement never implies a panel: slots render in the chat, the panel
 * renders in the sidebar, and the host never duplicates one view into both.
 * That keeps "sidebar plugins never duplicate into the chat" true by
 * construction rather than by a rendering accident.
 */
export function isPanelPlugin(plugin: WebPluginDescriptor): boolean {
  return plugin.surfaces.some((surface) => surface.kind === "sidebar");
}

/**
 * The panels that can be opened right now: a view-driven panel needs a
 * published non-dialog view, a `sessionPanel` plugin (Files) needs a session.
 */
export function availablePanelPlugins(
  plugins: readonly WebPluginDescriptor[],
  views: Record<string, WebView> | null,
  hasSession = false,
): WebPluginDescriptor[] {
  return plugins.filter((plugin) => {
    if (!isPanelPlugin(plugin)) return false;
    if (plugin.sessionPanel === true) return hasSession;
    const view = views?.[plugin.id];
    return view != null && view.type !== "dialog";
  });
}
