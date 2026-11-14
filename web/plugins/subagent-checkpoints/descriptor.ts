import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";

export const subagentCheckpointsPlugin: WebPluginDescriptor = {
  id: "subagent-checkpoints",
  extension: "subagent-checkpoints",
  title: "Delegated work",
  icon: "users",
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
  ],
};

export default subagentCheckpointsPlugin;
