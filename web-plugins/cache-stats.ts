import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const cacheStatsPlugin: WebPluginDescriptor = {
  id: "cache-stats",
  extension: "cache-stats",
  title: "Cache health",
  description: "Monitor prompt cache hit rates and token efficiency across models.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "slot", slot: "bottom" },
  ],
};

export default cacheStatsPlugin;
