import type { WebPluginDescriptor } from "../../../../lib/web-plugins/descriptor.ts";
import {
  HELLO_WORLD_GREET_ACTION,
  HELLO_WORLD_PLUGIN_ID,
} from "../../../../lib/hello-world-web-view.ts";

/**
 * Copy this file to `web/core/plugins/hello-world/descriptor.ts` and import it
 * in `web/core/plugins/index.ts` (the `WEB_PLUGINS` registry). The descriptor
 * is declarative data only — it maps the extension's published view to a
 * placement and declares the actions the web may forward back. No logic here.
 */
export const helloWorldPlugin: WebPluginDescriptor = {
  id: HELLO_WORLD_PLUGIN_ID,
  extension: "hello-world",
  title: "Hello world",
  description: "Reference plugin: a status view and one action over the bridge.",
  ui: [{
    id: "greeting",
    component: "ui.plugin-view.v1",
    view: HELLO_WORLD_PLUGIN_ID,
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "top", collision: "shrink" },
  }],
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "top" },
  ],
  actions: [
    { id: HELLO_WORLD_GREET_ACTION, title: "Greet again" },
  ],
};

export default helloWorldPlugin;