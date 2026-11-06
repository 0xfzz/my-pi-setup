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
  ui: [{
    id: "summary",
    component: "ui.session-sidebar-row.v1",
    view: "dashboard",
    strategy: "compact",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "session.sidebar", collision: "shrink" },
  }],
  actions: [
    {
      id: "request-sync",
      title: "Request fresh snapshot",
      confirm: "request sync",
    },
  ],
};

export default dashboardPlugin;
