/** Files browser half: owns its panel registration and plugin-owned styles. */
import { createElement } from "react";
import {
  installBrowserStyles,
  registerPluginPanel,
  unregisterPluginPanel,
} from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { FILES_PLUGIN_ID } from "../contract.ts";
import { FilesPanel } from "../FilesPanel.tsx";
import styles from "../files.css";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${FILES_PLUGIN_ID} browser half mounted`);
  const removeStyles = installBrowserStyles(FILES_PLUGIN_ID, styles);
  registerPluginPanel(FILES_PLUGIN_ID, (props) => createElement(FilesPanel, {
    open: props.open,
    onClose: props.onClose,
    sessionId: props.sessionId,
    rootLabel: props.rootLabel,
  }));
  return () => {
    unregisterPluginPanel(FILES_PLUGIN_ID);
    removeStyles();
    ctx.logger.info(`${FILES_PLUGIN_ID} browser half unmounted`);
  };
}
