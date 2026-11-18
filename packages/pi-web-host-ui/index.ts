/**
 * Node-safe alias for the pure host helpers used by plugin support modules.
 *
 * The browser import map resolves `@pi-web/host-ui` to the full `/host/ui.js`
 * bundle (React components and registries). Node-based unit tests only need
 * the transport/helper layer, so this alias exposes exactly those pure parts
 * without pulling JSX into the repository typecheck.
 */
export { getJson, postJson } from "../../web/core/client/plugin-system/api-client.ts";
export type { ApiFailure, ApiResult } from "../../web/core/client/plugin-system/api-client.ts";
export { protocolClient } from "../../web/core/client/protocol-client.ts";
export { classifyFile, DOCUMENT_PREVIEW_MAX_BYTES } from "../../web/core/shared/file-kind.ts";
export type { FileKind } from "../../web/core/shared/file-kind.ts";
export { isCompactViewport } from "../../web/core/shared/responsive.ts";
export type { ViewportOrientation } from "../../web/core/shared/responsive.ts";
export {
  KERNEL_MANAGER_ID,
  PLUGIN_MANAGER_ACTIONS,
  PLUGIN_MANAGER_API,
} from "../../web/core/shared/plugin-manager.ts";
export type {
  PluginCapabilityAction,
  PluginManagerAction,
  PluginManagerAuditEntry,
  PluginManagerCommand,
  PluginManagerOutcome,
  PluginManagerReport,
  PluginManagerRow,
} from "../../web/core/shared/plugin-manager.ts";
export type {
  PiApiName,
  PiApiParams,
  PiApiResult,
  PiMcpConfigState,
  PiMcpServerEntry,
  PiMcpWriteParams,
} from "../../web/core/shared/pi-api.ts";
export { validateView, VIEW_MAX_ROWS } from "../../web/core/plugin-contracts/view.ts";
export type {
  GraphEdge,
  GraphNode,
  GraphWebView,
  ListStatus,
  StatusTone,
  WebView,
} from "../../web/core/plugin-contracts/view.ts";
