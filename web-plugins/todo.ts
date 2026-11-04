import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const todoPlugin: WebPluginDescriptor = {
  id: "todo",
  extension: "todo",
  title: "Todo",
  description: "Task intent graph, dependencies, and execution state.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/todo" },
  ],
};

export default todoPlugin;
