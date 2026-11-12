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
): WebPluginDescriptor[] {
  return plugins.filter((plugin) => {
    const view = views?.[plugin.id];
    return isPanelPlugin(plugin) && view != null && view.type !== "dialog";
  });
}
