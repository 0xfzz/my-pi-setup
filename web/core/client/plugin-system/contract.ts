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

/** The working-indicator model streamed per session (ui.working.changed). */
export interface WorkingSegmentLike {
  text: string;
  color: string | null;
  bold?: boolean;
}
export interface WorkingModelLike {
  message: string | null;
  visible: boolean;
  frames: string[] | null;
  intervalMs: number;
  messageSegments?: WorkingSegmentLike[] | null;
  frameColors?: (string | null)[] | null;
}
