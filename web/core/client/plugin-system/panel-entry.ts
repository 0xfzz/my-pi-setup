import type { WebPluginDescriptor, WebPluginIcon } from "./contract.ts";
import { isPanelPlugin } from "./panel-policy.ts";

/** A launcher row: a panel the user can open, or an unavailable one to explain. */
export interface PanelEntry {
  id: string;
  title: string;
  icon: WebPluginIcon;
  available: boolean;
  /** Why an installed panel cannot be opened now; shown in the ⋯ menu. */
  unavailableReason?: string;
}

/** The host-owned Files panel — a built-in, not a plugin descriptor. */
export const FILES_PANEL_ID = "files";

/**
 * The launcher's menu lists every installed, sidebar-eligible panel in
 * registry order, then the built-in Files panel. `available` reflects
 * whether it can be opened for the current session (a plugin needs a
 * published non-dialog view; Files needs a selected session).
 */
export function buildPanelEntries(
  plugins: readonly WebPluginDescriptor[],
  availablePluginIds: ReadonlySet<string>,
  filesAvailable: boolean,
): PanelEntry[] {
  const entries: PanelEntry[] = plugins
    .filter(isPanelPlugin)
    .map((plugin) => ({
      id: plugin.id,
      title: plugin.title,
      icon: plugin.icon ?? "puzzle-piece",
      available: availablePluginIds.has(plugin.id),
      ...(availablePluginIds.has(plugin.id) ? {} : { unavailableReason: "No view published yet" }),
    }));

  entries.push({
    id: FILES_PANEL_ID,
    title: "Files",
    icon: "files",
    available: filesAvailable,
    ...(filesAvailable ? {} : { unavailableReason: "No session selected" }),
  });

  return entries;
}