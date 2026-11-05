import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const todoPlugin: WebPluginDescriptor = {
  id: "todo",
  extension: "todo",
  title: "Todo",
  description: "Task intent graph, dependencies, and execution state.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "top" },
  ],
};

export default todoPlugin;
