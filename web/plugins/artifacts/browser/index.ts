/** Artifacts browser half: owns its panel registration. */
import { createElement } from "react";
import { registerPluginPanel } from "../../../core/client/plugin-system/panel-registry.tsx";
import { ARTIFACTS_PLUGIN_ID } from "../contract.ts";
import { ArtifactsPanel } from "../ArtifactsPanel.tsx";
import type { WebPluginContext } from "../../../core/client/plugin-system/browser-loader.ts";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${ARTIFACTS_PLUGIN_ID} browser half mounted`);
  registerPluginPanel(ARTIFACTS_PLUGIN_ID, (props) => createElement(ArtifactsPanel, {
    open: props.open,
    onClose: props.onClose,
    view: props.view,
  }));
  return () => ctx.logger.info(`${ARTIFACTS_PLUGIN_ID} browser half unmounted`);
}
