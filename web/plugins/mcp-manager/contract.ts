/**
 * The mcp-manager bridge contract: the plugin id shared by the web
 * descriptor and the "mcp-manager" pi extension.
 *   - web/plugins/mcp-manager/descriptor.ts declares the page surface,
 *   - extensions/mcp-manager.ts registers the /mcp-manager-reload command
 *     that applies web-made mcp.json edits to a running session.
 */
export const MCP_MANAGER_PLUGIN_ID = "mcp-manager";
