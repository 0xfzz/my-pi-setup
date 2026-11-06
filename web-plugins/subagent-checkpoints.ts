import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const subagentCheckpointsPlugin: WebPluginDescriptor = {
  id: "subagent-checkpoints",
  extension: "subagent-checkpoints",
  title: "Delegated work",
  description: "Child agent checkpointing, milestone sidecars, and state recovery.",
  ui: [{
    id: "checkpoints",
    component: "ui.plugin-view.v1",
    view: "subagent-checkpoints",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "center", collision: "shrink" },
  }],
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "center" },
  ],
};

export default subagentCheckpointsPlugin;
