import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";

export const artifactsPlugin: WebPluginDescriptor = {
  id: "artifacts",
  extension: "artifacts",
  title: "Artifacts",
  icon: "files",
  description: "Persisted workspace artifacts catalog and editor.",
  ui: [{
    id: "catalog",
    component: "ui.plugin-view.v1",
    view: "artifacts",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "floating", maxWidth: 400, maxHeight: 360 },
  }],
  surfaces: [
    { kind: "sidebar" },
  ],
};

export default artifactsPlugin;
