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

/**
 * The launcher's menu lists every installed, sidebar-eligible plugin in
 * registry order. `available` reflects whether it can be opened for the
 * current session (a view-driven plugin needs a published non-dialog view;
 * a `sessionPanel` plugin such as Files needs a selected session).
 */
export function buildPanelEntries(
  plugins: readonly WebPluginDescriptor[],
  availablePluginIds: ReadonlySet<string>,
  hasSelectedSession: boolean,
): PanelEntry[] {
  return plugins
    .filter(isPanelPlugin)
    .map((plugin) => {
      const available = plugin.sessionPanel === true
        ? hasSelectedSession
        : availablePluginIds.has(plugin.id);
      const unavailableReason = plugin.sessionPanel === true
        ? "No session selected"
        : "No view published yet";
      return {
        id: plugin.id,
        title: plugin.title,
        icon: plugin.icon ?? "puzzle-piece",
        available,
        ...(available ? {} : { unavailableReason }),
      };
    });
}
