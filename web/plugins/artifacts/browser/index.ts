/** Artifacts browser half: owns its panel registration and plugin-owned styles. */
import { createElement } from "react";
import {
  installBrowserStyles,
  registerPluginPanel,
  unregisterPluginPanel,
} from "@pi-web/host-ui";
import type { WebPluginContext } from "@pi-web/bridge";
import { ARTIFACTS_PLUGIN_ID } from "../contract.ts";
import { ArtifactsPanel } from "../ArtifactsPanel.tsx";
import styles from "../artifacts.css";

export function mount(_el: HTMLElement, ctx: WebPluginContext): () => void {
  ctx.logger.info(`${ARTIFACTS_PLUGIN_ID} browser half mounted`);
  const removeStyles = installBrowserStyles(ARTIFACTS_PLUGIN_ID, styles);
  registerPluginPanel(ARTIFACTS_PLUGIN_ID, (props) => createElement(ArtifactsPanel, {
    open: props.open,
    onClose: props.onClose,
    view: props.view,
  }));
  return () => {
    unregisterPluginPanel(ARTIFACTS_PLUGIN_ID);
    removeStyles();
    ctx.logger.info(`${ARTIFACTS_PLUGIN_ID} browser half unmounted`);
  };
}
