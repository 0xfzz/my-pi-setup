import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import { WEB_BRIDGE_PLUGIN_ID } from "./contract.ts";

/**
 * The web half of the bridge extension. It surfaces bridged headers, footers
 * and notices as host-rendered status views; disabling it removes only those
 * surfaces, never the extension that produced them.
 */
export const webBridgePlugin: WebPluginDescriptor = {
  id: WEB_BRIDGE_PLUGIN_ID,
  extension: "bridge",
  title: "Pi Web Bridge",
  description: "Maps bridged extension surfaces into host-rendered web views.",
  surfaces: [{ kind: "override", region: "header" }],
};
export default webBridgePlugin;
