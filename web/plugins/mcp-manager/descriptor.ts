import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import { MCP_MANAGER_PLUGIN_ID } from "./contract.ts";

export const mcpManagerPlugin: WebPluginDescriptor = {
  id: MCP_MANAGER_PLUGIN_ID,
  extension: "mcp-manager",
  title: "MCP servers",
  icon: "sliders",
  description:
    "Setup and management for pi's MCP servers: the same mcp.json pi's /mcp reads, edited through pi's own config surface. A running session applies edits on /reload (or /mcp-manager-reload).",
  surfaces: [
    // Page-only on purpose: the manager is workspace state on a bespoke
    // page, not a session view, so a sidebar surface would sit in the panel
    // launcher forever as "No view published yet". Pages are reachable via
    // the plugin page nav on any plugin page.
    { kind: "page", path: "/plugins/mcp-manager" },
  ],
};

export default mcpManagerPlugin;
