import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import { PLUGIN_MANAGER_PLUGIN_ID } from "./contract.ts";

/**
 * The plugin manager itself is a first-party `core.*` plugin: safe mode boots
 * only core plugins, so the operator can always reach the surface that fixes a
 * broken one (PRD §6.5, R21). It is page-only — workspace state, not a session view.
 */
export const pluginManagerPlugin: WebPluginDescriptor = {
  id: PLUGIN_MANAGER_PLUGIN_ID,
  extension: "web-core.plugin-manager",
  title: "Plugins",
  icon: "puzzle-piece",
  description:
    "Every installed plugin with its kernel state, capabilities and mounted routes; enable, disable, reload or clear a quarantine.",
  surfaces: [
    { kind: "page", path: "/plugins/core.plugin-manager" },
  ],
};

export default pluginManagerPlugin;
