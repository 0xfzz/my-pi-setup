import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  EXAMPLE_OVERRIDE_PLUGIN_ID,
  EXAMPLE_OVERRIDE_SHOW_ACTION,
} from "./contract.ts";

/**
 * Reference override plugin: while its view is published, the minimal web
 * client renders that view in place of the composer region; when no view is
 * published the built-in composer returns. Inert until its action runs, so
 * the default install keeps the minimal base UI.
 */
export const exampleOverridePlugin: WebPluginDescriptor = {
  id: EXAMPLE_OVERRIDE_PLUGIN_ID,
  extension: "example-override",
  title: "Composer override",
  description:
    "Reference plugin: replaces the composer region with a declarative view while it is published (opt in via its action).",
  surfaces: [
    { kind: "override", region: "composer" },
    { kind: "page", path: "/plugins/example-override" },
  ],
  actions: [
    {
      id: EXAMPLE_OVERRIDE_SHOW_ACTION,
      title: "Replace the composer",
    },
  ],
};

export default exampleOverridePlugin;
