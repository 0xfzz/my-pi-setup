/**
 * Shared UI/runtime surface for first-party plugin browser halves.
 *
 * The host app and external plugin bundles import the same specifier through
 * the document import map, so registries, React hooks and renderers remain
 * one module instance even when a plugin module comes from a blob URL.
 */
export { getPluginPanel, registerPluginPanel, unregisterPluginPanel } from "../plugin-system/panel-registry.tsx";
export type { HostPanelComponent, HostPanelProps } from "../plugin-system/panel-registry.tsx";
export { getPluginPage, registerPluginPage, unregisterPluginPage } from "../plugin-system/page-registry.ts";
export type { HostPageComponent, HostPageProps } from "../plugin-system/page-registry.ts";
export { LoadingSpinner } from "../plugin-system/LoadingSpinner.tsx";
export { MarkdownBody } from "../plugin-system/markdown.tsx";
export { default as CodeMirrorView } from "../plugin-system/CodeMirrorView.tsx";
export { PluginViewRenderer } from "../plugin-system/PluginViewRenderer.tsx";
export { getJson, postJson } from "../plugin-system/api-client.ts";
export type { ApiFailure, ApiResult } from "../plugin-system/api-client.ts";
export { classifyFile, DOCUMENT_PREVIEW_MAX_BYTES } from "../../shared/file-kind.ts";
export type { FileKind } from "../../shared/file-kind.ts";
export { isCompactViewport } from "../../shared/responsive.ts";
export type { ViewportOrientation } from "../../shared/responsive.ts";
export { protocolClient } from "../protocol-client.ts";
export {
  KERNEL_MANAGER_ID,
  PLUGIN_MANAGER_ACTIONS,
  PLUGIN_MANAGER_API,
} from "../../shared/plugin-manager.ts";
export type {
  PluginCapabilityAction,
  PluginManagerAction,
  PluginManagerAuditEntry,
  PluginManagerCommand,
  PluginManagerOutcome,
  PluginManagerReport,
  PluginManagerRow,
} from "../../shared/plugin-manager.ts";
export type {
  PiApiName,
  PiApiParams,
  PiApiResult,
  PiMcpConfigState,
  PiMcpServerEntry,
  PiMcpWriteParams,
} from "../../shared/pi-api.ts";
export { validateView, VIEW_MAX_ROWS } from "../../plugin-contracts/view.ts";
export type {
  GraphEdge,
  GraphNode,
  GraphWebView,
  ListStatus,
  StatusTone,
  WebView,
} from "../../plugin-contracts/view.ts";
export { webUiText } from "../../plugin-contracts/ui-event-models.ts";
export { MESSAGE_CATALOG } from "../../protocol/catalog.ts";
export type { BridgeEnvelope } from "../../protocol/envelope.ts";
export type { WebPluginContext } from "@pi-web/bridge";

/** Install plugin-owned CSS once and return the cleanup used on unmount. */
export function installBrowserStyles(id: string, css: string): () => void {
  const style = document.createElement("style");
  style.dataset.piPluginStyles = id;
  style.textContent = css;
  document.head.append(style);
  return () => { style.remove(); };
}
