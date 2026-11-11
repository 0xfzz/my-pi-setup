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
} from "../../../lib/web-plugins/view.ts";
export type { ActionDescriptor } from "../../../lib/web-plugins/actions.ts";
export type { WebPluginDescriptor } from "../../../lib/web-plugins/descriptor.ts";
export type { WebPluginUiContribution } from "../../../lib/web-plugins/ui-contracts.ts";

/** The working-indicator model streamed per session (ui.working.changed). */
export interface WorkingModelLike {
  message: string | null;
  visible: boolean;
  frames: string[] | null;
  intervalMs: number;
}
