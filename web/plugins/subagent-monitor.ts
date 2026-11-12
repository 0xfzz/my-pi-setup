import type { WebPluginDescriptor } from "../../lib/web-plugins/descriptor.ts";
import { SUBAGENT_MONITOR_PLUGIN_ID, SUBAGENT_MONITOR_SYNC_ACTION } from "../../lib/dashboard/graph-view.ts";

export const subagentMonitorPlugin: WebPluginDescriptor = {
  id: SUBAGENT_MONITOR_PLUGIN_ID,
  extension: "dashboard",
  title: "Subagent monitor",
  icon: "tree-structure",
  description: "Per-session delegated work graph: parent, child workers, handoffs, reviews and escalations, each with expandable detail. Data parity with the standalone dashboard.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/subagent-monitor" },
  ],
  ui: [{
    id: "graph",
    component: "ui.plugin-view.v1",
    view: SUBAGENT_MONITOR_PLUGIN_ID,
    strategy: "compact",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "session.sidebar", collision: "shrink" },
  }],
  actions: [
    {
      id: SUBAGENT_MONITOR_SYNC_ACTION,
      title: "Request fresh snapshot",
      confirm: "request sync",
    },
  ],
};

export default subagentMonitorPlugin;
