import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const bubblySpinnerPlugin: WebPluginDescriptor = {
  id: "bubbly-spinner",
  extension: "bubbly-spinner",
  title: "Bubbly spinner",
  icon: "spinner",
  description: "Animated working message indicator and session activity status.",
  surfaces: [
    { kind: "sidebar" },
  ],
  ui: [
    {
      id: "working",
      component: "ui.working-indicator.v1",
      strategy: "compact",
      scope: "session",
      placement: { kind: "anchor", anchor: "chat.working" },
      priority: 5,
      override: { target: "ui.working-indicator.v1", mode: "wrap", fallback: "builtin" },
    },
  ],
};

export default bubblySpinnerPlugin;
