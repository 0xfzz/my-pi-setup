import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const subagentCheckpointsPlugin: WebPluginDescriptor = {
  id: "subagent-checkpoints",
  extension: "subagent-checkpoints",
  title: "Delegated work",
  description: "Child agent checkpointing, milestone sidecars, and state recovery.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/subagent-checkpoints" },
  ],
};

export default subagentCheckpointsPlugin;
