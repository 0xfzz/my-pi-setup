import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";

export const dashboardPlugin: WebPluginDescriptor = {
  id: "dashboard",
  extension: "dashboard",
  title: "Delegated work graph",
  description: "Delegated work graph and artifact summary; data parity with the standalone dashboard.",
  surfaces: [
    { kind: "sidebar" },
    { kind: "page", path: "/plugins/dashboard" },
  ],
  actions: [
    {
      id: "request-sync",
      title: "Request fresh snapshot",
      confirm: "request sync",
    },
  ],
};

export default dashboardPlugin;
