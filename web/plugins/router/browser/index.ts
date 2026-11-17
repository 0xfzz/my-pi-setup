/** Router browser half: owns its panel registration. */
import { registerPluginPanel } from "../../../core/client/plugin-system/panel-registry.tsx";
import { ROUTER_PLUGIN_ID } from "../contract.ts";
import { RouterPanel } from "../RouterPanel.tsx";
import type { WebPluginContext } from "../../../core/client/plugin-system/browser-loader.ts";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${ROUTER_PLUGIN_ID} browser half mounted`);
  registerPluginPanel(ROUTER_PLUGIN_ID, RouterPanel);
  return () => ctx.logger.info(`${ROUTER_PLUGIN_ID} browser half unmounted`);
}
