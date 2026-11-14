import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  ASK_USER_CANCEL_ACTION,
  ASK_USER_OPTION_ACTION,
  ASK_USER_PLUGIN_ID,
  ASK_USER_TEXT_ACTION,
} from "./contract.ts";

export const askUserPlugin: WebPluginDescriptor = {
  id: ASK_USER_PLUGIN_ID,
  extension: "ask-user",
  title: "Ask user",
  description:
    "Interactive clarification dialog: presents a question with optional choices and a typed answer input, resolving through the plugin action pipeline.",
  surfaces: [],
  ui: [{
    id: "dialog",
    component: "ui.floating-layer.v1",
    view: ASK_USER_PLUGIN_ID,
    scope: "session",
    visibleWhen: "has-view",
    placement: { kind: "anchor", anchor: "viewport.overlay" },
  }],
  actions: [
    { id: ASK_USER_OPTION_ACTION, title: "Select option" },
    { id: ASK_USER_TEXT_ACTION, title: "Submit typed answer" },
    { id: ASK_USER_CANCEL_ACTION, title: "Cancel" },
  ],
};

export default askUserPlugin;
