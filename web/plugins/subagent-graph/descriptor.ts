import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import { SUBAGENT_GRAPH_PLUGIN_ID, SUBAGENT_GRAPH_SYNC_ACTION } from "./contract.ts";

/**
 * Subagent graph: the per-session picture of delegated work.
 *
 * One plugin, two surfaces of the same data — the graph view the web client
 * renders in the sidebar and on this plugin's page, and the standalone app the
 * plugin's own producer serves for a full-window look. Both read the same
 * snapshot, so the panel and the standalone window cannot disagree.
 */
export const subagentGraphPlugin: WebPluginDescriptor = {
  id: SUBAGENT_GRAPH_PLUGIN_ID,
  extension: "subagent-graph",
  title: "Subagent graph",
  icon: "tree-structure",
  description:
    "Per-session delegated work graph: parent, child workers, handoffs, reviews and escalations, each with expandable detail.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: `/plugins/${SUBAGENT_GRAPH_PLUGIN_ID}` },
  ],
  ui: [{
    id: "graph",
    component: "ui.plugin-view.v1",
    view: SUBAGENT_GRAPH_PLUGIN_ID,
    strategy: "compact",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "session.sidebar", collision: "shrink" },
  }],
  actions: [
    {
      id: SUBAGENT_GRAPH_SYNC_ACTION,
      title: "Request fresh snapshot",
      confirm: "request sync",
    },
  ],
};

export default subagentGraphPlugin;
