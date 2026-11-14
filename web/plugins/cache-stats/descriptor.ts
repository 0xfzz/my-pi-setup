import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";

export const cacheStatsPlugin: WebPluginDescriptor = {
  id: "cache-stats",
  extension: "cache-stats",
  title: "Cache health",
  icon: "chart-bar",
  description: "Monitor prompt cache hit rates and token efficiency across models.",
  ui: [{
    id: "health",
    component: "ui.plugin-view.v1",
    view: "cache-stats",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "region", region: "bottom", collision: "shrink" },
  }],
  surfaces: [
    { kind: "sidebar" },
  ],
};

export default cacheStatsPlugin;
