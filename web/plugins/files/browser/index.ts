/** Files browser half: owns its panel registration, core owns only the registry. */
import { createElement } from "react";
import { registerPluginPanel } from "../../../core/client/plugin-system/panel-registry.tsx";
import { FILES_PLUGIN_ID } from "../contract.ts";
import { FilesPanel } from "../FilesPanel.tsx";
import type { WebPluginContext } from "../../../core/client/plugin-system/browser-loader.ts";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${FILES_PLUGIN_ID} browser half mounted`);
  registerPluginPanel(FILES_PLUGIN_ID, (props) => createElement(FilesPanel, {
    open: props.open,
    onClose: props.onClose,
    sessionId: props.sessionId,
    rootLabel: props.rootLabel,
  }));
  return () => ctx.logger.info(`${FILES_PLUGIN_ID} browser half unmounted`);
}
