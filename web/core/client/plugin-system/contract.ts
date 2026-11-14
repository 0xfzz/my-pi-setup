// Shared structural types for the client, re-exported from the root repo's
// plugin contract with type-only imports (nothing here reaches the bundle).

export type {
  WebView,
  KvWebView,
  ListWebView,
  StatusWebView,
  GraphWebView,
  GraphNode,
  GraphEdge,
  ListStatus,
  DialogWebView,
  DialogAction,
} from "../../plugin-contracts/view.ts";
export type { ActionDescriptor } from "../../plugin-contracts/actions.ts";
export type { WebPluginDescriptor, WebPluginIcon } from "../../plugin-contracts/descriptor.ts";
export type { WebPluginUiContribution } from "../../plugin-contracts/ui-contracts.ts";

// The models the SSE stream carries, named from their single definition:
// the wire frame's fields and the plugin contract's event payloads.
export type {
  PluginCustomPanelState as CustomPanelLike,
  PluginStateFrame,
  PluginWidgetState as WidgetModelLike,
} from "../../shared/plugin-state.ts";
export type {
  WebNotification as WebNotificationLike,
  WorkingModel as WorkingModelLike,
  WorkingSegment as WorkingSegmentLike,
} from "../../plugin-contracts/ui-event-models.ts";
