// Region override resolution — shared by the server (diagnostics in the
// plugin_state frame) and the client (region fallback rendering).
//
// A plugin declares { kind: "override", region } on its descriptor; while it
// has a view published for the session, that view replaces the base region.
// When the view is absent the built-in region returns automatically. With
// several candidates, the last plugin in registry order wins, and every
// candidate is reported as a conflict.

import type { WebPluginDescriptor, WebPluginRegion } from "../../../lib/web-plugins/descriptor.ts";
import type { WebView } from "../../../lib/web-plugins/view.ts";

export type { WebPluginRegion };

export interface RegionOverride {
  pluginId: string;
  view: WebView;
}

export interface RegionConflict {
  region: WebPluginRegion;
  pluginIds: string[];
}

export interface RegionResolution {
  regions: Partial<Record<WebPluginRegion, RegionOverride>>;
  conflicts: RegionConflict[];
}

export function resolveRegionOverrides(
  plugins: readonly WebPluginDescriptor[],
  views: Record<string, WebView> | null | undefined,
): RegionResolution {
  const regions: Partial<Record<WebPluginRegion, RegionOverride>> = {};
  const conflicts: RegionConflict[] = [];
  if (views === null || views === undefined) {
    return { regions, conflicts };
  }

  for (const plugin of plugins) {
    for (const surface of plugin.surfaces) {
      if (surface.kind !== "override") continue;
      const view = views[plugin.id];
      if (view === undefined || view === null) continue;
      const previous = regions[surface.region];
      regions[surface.region] = { pluginId: plugin.id, view };
      if (previous !== undefined) {
        let conflict = conflicts.find((entry) => entry.region === surface.region);
        if (conflict === undefined) {
          conflict = { region: surface.region, pluginIds: [previous.pluginId] };
          conflicts.push(conflict);
        }
        if (!conflict.pluginIds.includes(previous.pluginId)) {
          conflict.pluginIds.push(previous.pluginId);
        }
        if (!conflict.pluginIds.includes(plugin.id)) {
          conflict.pluginIds.push(plugin.id);
        }
      }
    }
  }
  return { regions, conflicts };
}
