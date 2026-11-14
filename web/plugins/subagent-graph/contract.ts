/**
 * The subagent-graph bridge contract: the plugin id and the read-only sync
 * action the "subagent-graph" pi extension and this web descriptor share.
 *   - extensions/subagent-graph.ts imports these to publish the graph view and
 *     answer the sync action,
 *   - web/plugins/subagent-graph/descriptor.ts imports these to declare them.
 * The extension never imports the descriptor, nor the descriptor the extension.
 */
export const SUBAGENT_GRAPH_PLUGIN_ID = "subagent-graph";
export const SUBAGENT_GRAPH_SYNC_ACTION = "request-sync";