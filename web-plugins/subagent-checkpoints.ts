import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const subagentCheckpointsPlugin: WebPluginDescriptor = {
  id: "subagent-checkpoints",
  extension: "subagent-checkpoints",
  title: "Delegated work",
  description: "Child agent checkpointing, milestone sidecars, and state recovery.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "center" },
  ],
};

export default subagentCheckpointsPlugin;
