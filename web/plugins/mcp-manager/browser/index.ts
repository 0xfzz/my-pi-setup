/** MCP manager browser half: owns its bespoke page and plugin-owned styles. */
import { createElement } from "react";
import {
  installBrowserStyles,
  registerPluginPage,
  unregisterPluginPage,
  type HostPageProps,
} from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { MCP_MANAGER_PLUGIN_ID } from "../contract.ts";
import { McpManagerPage } from "../McpManagerPage.tsx";
import styles from "../mcp-manager.css";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${MCP_MANAGER_PLUGIN_ID} browser half mounted`);
  const removeStyles = installBrowserStyles(MCP_MANAGER_PLUGIN_ID, styles);
  registerPluginPage(MCP_MANAGER_PLUGIN_ID, (props: HostPageProps) =>
    createElement(McpManagerPage, { sessionId: props.sessionId }));
  return () => {
    unregisterPluginPage(MCP_MANAGER_PLUGIN_ID);
    removeStyles();
    ctx.logger.info(`${MCP_MANAGER_PLUGIN_ID} browser half unmounted`);
  };
}
