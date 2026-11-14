/**
 * mcp-manager — the pi side of the web MCP manager plugin.
 *
 * The web page edits mcp.json through the pi_api facade (mcp.read /
 * mcp.write), which writes pi's own config files. A running session only
 * picks those edits up on reload, exactly like after a `pi mcp add` from a
 * shell — so this extension registers a dedicated reload command the user
 * can run right after editing from the web. `/mcp-manager-reload` is a
 * focused alias for `/reload`; the handler delegates to the context's own
 * reload so pi re-reads extensions and reconnects the configured servers.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function mcpManagerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("mcp-manager-reload", {
    description: "Apply MCP edits made in the web MCP manager to this running session",
    handler: async (_args: string, ctx) => {
      await ctx.reload();
    },
  });
}
