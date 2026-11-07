import type { WebPluginDescriptor } from "../lib/web-plugins/descriptor.ts";
import { MODES_LEAVE_PLAN_ACTION, MODES_PLUGIN_ID } from "../lib/modes-web-view.ts";

export const modesPlugin: WebPluginDescriptor = {
  id: MODES_PLUGIN_ID,
  extension: "modes",
  title: "Input mode",
  description: "Current input mode (Normal or Plan) shown above the composer, with an action to leave Plan mode.",
  ui: [{
    id: "mode",
    component: "ui.plugin-view.v1",
    view: MODES_PLUGIN_ID,
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "chat.composer", order: -1 },
  }],
  surfaces: [
    { kind: "sidebar" },
  ],
  actions: [
    {
      id: MODES_LEAVE_PLAN_ACTION,
      title: "Leave plan mode",
      confirm: "leave plan mode",
    },
  ],
};

export default modesPlugin;
