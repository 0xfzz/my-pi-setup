import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import { ARTIFACTS_PLUGIN_ID } from "./contract.ts";

export const artifactsPlugin: WebPluginDescriptor = {
  id: ARTIFACTS_PLUGIN_ID,
  extension: "artifacts",
  title: "Artifacts",
  icon: "files",
  description: "Persisted workspace artifacts catalog and editor.",
  ui: [{
    id: "catalog",
    component: "ui.plugin-view.v1",
    view: ARTIFACTS_PLUGIN_ID,
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "floating", maxWidth: 400, maxHeight: 360 },
  }],
  surfaces: [
    { kind: "sidebar" },
  ],
};

export default artifactsPlugin;
