/** Plugin manager browser half: owns its bespoke page and plugin-owned styles. */
import { createElement } from "react";
import {
  installBrowserStyles,
  registerPluginPage,
  unregisterPluginPage,
  type HostPageProps,
} from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { PLUGIN_MANAGER_PLUGIN_ID } from "../contract.ts";
import { PluginManagerPage } from "../PluginManagerPage.tsx";
import styles from "../plugin-manager.css";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${PLUGIN_MANAGER_PLUGIN_ID} browser half mounted`);
  const removeStyles = installBrowserStyles(PLUGIN_MANAGER_PLUGIN_ID, styles);
  registerPluginPage(PLUGIN_MANAGER_PLUGIN_ID, (_props: HostPageProps) => createElement(PluginManagerPage));
  return () => {
    unregisterPluginPage(PLUGIN_MANAGER_PLUGIN_ID);
    removeStyles();
    ctx.logger.info(`${PLUGIN_MANAGER_PLUGIN_ID} browser half unmounted`);
  };
}
