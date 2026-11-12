import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const todoPlugin: WebPluginDescriptor = {
  id: "todo",
  extension: "todo",
  title: "Todo",
  icon: "list-checks",
  description: "Task intent graph, dependencies, and execution state.",
  ui: [{
    id: "tasks",
    component: "ui.plugin-view.v1",
    view: "todo",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "top", collision: "shrink" },
  }],
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "top" },
  ],
};

export default todoPlugin;
