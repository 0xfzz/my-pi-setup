import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  HELLO_WORLD_GREET_ACTION,
  HELLO_WORLD_PLUGIN_ID,
} from "./contract.ts";

/**
 * The declarative bridge for the hello-world extension. Copy this file to
 * `web/plugins/<id>/descriptor.ts` and register it in `web/registry.config.ts`
 * (the `WEB_PLUGINS` registry). Data only — it maps the extension's published
 * view to a placement and declares the action the web forwards back.
 */
export const helloWorldPlugin: WebPluginDescriptor = {
  id: HELLO_WORLD_PLUGIN_ID,
  extension: "hello-world",
  title: "Hello world",
  description: "Reference bridge: a status view and one action.",
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