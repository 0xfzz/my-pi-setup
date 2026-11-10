import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";
import {
  AUTO_TITLE_PLUGIN_ID,
  AUTO_TITLE_REGENERATE_ACTION,
  AUTO_TITLE_TOGGLE_ACTION,
} from "../lib/auto-title-web-view.ts";

export const autoTitlePlugin: WebPluginDescriptor = {
  id: AUTO_TITLE_PLUGIN_ID,
  extension: "auto-title",
  title: "Session title",
  description: "Names an untitled session from its first exchange. Regenerate the title or switch auto-titling off.",
  ui: [{
    id: "title",
    component: "ui.plugin-view.v1",
    view: AUTO_TITLE_PLUGIN_ID,
    strategy: "compact",
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "session.header" },
  }],
  surfaces: [
    { kind: "sidebar" },
  ],
  actions: [
    { id: AUTO_TITLE_REGENERATE_ACTION, title: "Regenerate title" },
    { id: AUTO_TITLE_TOGGLE_ACTION, title: "Toggle auto title" },
  ],
};

export default autoTitlePlugin;
