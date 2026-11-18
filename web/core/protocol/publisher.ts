/** Compatibility shim: the typed publisher lives in the standalone SDK. */
export {
  BRIDGE_MESSAGE_EVENT,
  publishBridgeMessage,
  publishUiAutocompleteProvider,
  publishUiEditorComponent,
  publishUiFooter,
  publishUiHeader,
} from "@pi-web/bridge";
export type { BridgePublishTarget, PublishResult } from "@pi-web/bridge";
