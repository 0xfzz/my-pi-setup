import type { WebPluginDescriptor, WebView } from "./contract.ts";

/** Sidebar views have one home: the panel, never a second copy in the chat. */
export function isPanelPlugin(plugin: WebPluginDescriptor): boolean {
  return plugin.surfaces.some((surface) =>
    surface.kind === "sidebar"
    || (surface.kind === "slot" && (surface.slot === "center" || surface.slot === "floating")),
  );
}

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
