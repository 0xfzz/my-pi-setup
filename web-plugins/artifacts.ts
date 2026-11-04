import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const artifactsPlugin: WebPluginDescriptor = {
  id: "artifacts",
  extension: "artifacts",
  title: "Artifacts",
  description: "Persisted workspace artifacts catalog and editor.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/artifacts" },
  ],
};

export default artifactsPlugin;
