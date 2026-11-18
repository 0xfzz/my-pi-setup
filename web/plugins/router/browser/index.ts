/** Router browser half: owns its panel registration and plugin-owned styles. */
import { installBrowserStyles, registerPluginPanel, unregisterPluginPanel } from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { ROUTER_PLUGIN_ID } from "../contract.ts";
import { RouterPanel } from "../RouterPanel.tsx";
import styles from "../router.css";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${ROUTER_PLUGIN_ID} browser half mounted`);
  const removeStyles = installBrowserStyles(ROUTER_PLUGIN_ID, styles);
  registerPluginPanel(ROUTER_PLUGIN_ID, RouterPanel);
  return () => {
    unregisterPluginPanel(ROUTER_PLUGIN_ID);
    removeStyles();
    ctx.logger.info(`${ROUTER_PLUGIN_ID} browser half unmounted`);
  };
}
