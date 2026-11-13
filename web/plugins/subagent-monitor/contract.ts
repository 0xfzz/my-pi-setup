/**
 * The subagent-monitor bridge contract: the plugin id and the read-only sync
 * action the "dashboard" pi extension and this web descriptor share.
 *   - extensions/dashboard.ts imports these to publish the graph view and
 *     answer the sync action,
 *   - web/plugins/subagent-monitor/descriptor.ts imports these to declare them.
 * The extension never imports the descriptor, nor the descriptor the extension.
 */
export const SUBAGENT_MONITOR_PLUGIN_ID = "subagent-monitor";
export const SUBAGENT_MONITOR_SYNC_ACTION = "request-sync";