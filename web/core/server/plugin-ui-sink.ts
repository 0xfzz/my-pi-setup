// The host's side of the plugin → browser seam: one function that turns a
// plugin's publish into the store write an extension's publish already makes.
//
// Validation lives here, not in the kernel, because the store is what decides
// what a browser may render: a view goes through `recordPluginView` (shape
// validation plus the in-flight-action release a new view implies), and every
// other type goes through `webUiStore.publish`, which validates the event
// envelope, sanitizes text, applies the per-source rate limit and enforces the
// component caps. A plugin therefore cannot reach a state an extension could
// not, and it cannot write outside its own source key.

import type { PluginUiSink } from "../plugin-contracts/kernel/plugin-ui.ts";
import type { WebUiType } from "../plugin-contracts/ui-event-models.ts";
import { recordPluginView } from "./plugin-views.ts";
import { webUiStore } from "./ui-store.ts";

/** Types a plugin's server half may publish. Host-owned state is not in the list. */
const PLUGIN_PUBLISHABLE: ReadonlySet<WebUiType> = new Set<WebUiType>([
  "ui.view.changed",
  "ui.notify",
  "ui.status.changed",
  "ui.widget.changed",
]);

export function createPluginUiSink(): PluginUiSink {
  return {
    publish(sessionId: string, type: WebUiType, payload: unknown, sourceKey: string): boolean {
      if (!PLUGIN_PUBLISHABLE.has(type)) {
        // Reserved state (session lifecycle, title, editor, layout, action
        // relays) belongs to the host: a plugin must not be able to claim a
        // session is running, retitle it, or forge an action request.
        webUiStore.reject(sessionId, sourceKey, `plugins cannot publish ${type}`);
        return false;
      }
      if (type === "ui.view.changed") {
        const view = payload as { pluginId?: unknown; view?: unknown };
        return recordPluginView(sessionId, sourceKey, view.view);
      }
      return webUiStore.publish(sessionId, type, payload, sourceKey);
    },
  };
}
