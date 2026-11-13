import type { WebPluginDescriptor } from "../../../lib/web-plugins/descriptor.ts";

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
    { kind: "slot", slot: "floating" },
  ],
};

export default artifactsPlugin;
