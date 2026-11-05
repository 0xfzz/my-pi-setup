import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const bubblySpinnerPlugin: WebPluginDescriptor = {
  id: "bubbly-spinner",
  extension: "bubbly-spinner",
  title: "Bubbly spinner",
  description: "Animated working message indicator and session activity status.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "top" },
  ],
};

export default bubblySpinnerPlugin;
