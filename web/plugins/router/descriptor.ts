import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  ROUTER_BACK_ACTION,
  ROUTER_DELETE_ACTION,
  ROUTER_DELETE_CONFIRM_ACTION,
  ROUTER_FILTER_ACTION,
  ROUTER_OPEN_ACTION,
  ROUTER_PLUGIN_ID,
  ROUTER_SAVE_ACTION,
  ROUTER_TARGETS_ACTION,
  ROUTER_TOGGLE_ACTION,
} from "./contract.ts";

/**
 * The route editor's web surface.
 *
 * Dialog-only: the shared model-settings dialog's "Router" page embeds the
 * screen the extension publishes, and every answer routes back through the
 * plugin action pipeline to the pi process that owns account-router.json.
 * There is no panel and no page, so no placement is declared — a route is a
 * model, which is why it belongs beside "Models" and "Provider" rather than in
 * a window of its own.
 */
export const routerPlugin: WebPluginDescriptor = {
  id: ROUTER_PLUGIN_ID,
  extension: "account-router",
  title: "Router",
  icon: "sliders",
  description:
    "Fallback chains, routing methods and account pools, edited through the same shared dialog as the model picker: create a route, order its models, choose when it re-decides, and see which side still holds the prompt cache.",
  surfaces: [{ kind: "dialog" }],
  actions: [
    { id: ROUTER_OPEN_ACTION, title: "Edit a route, or start a new one" },
    { id: ROUTER_SAVE_ACTION, title: "Save the route on screen" },
    { id: ROUTER_TARGETS_ACTION, title: "Choose the route's models" },
    { id: ROUTER_TOGGLE_ACTION, title: "Tick or untick one model" },
    { id: ROUTER_FILTER_ACTION, title: "Filter the model list" },
    { id: ROUTER_DELETE_ACTION, title: "Ask before deleting the route" },
    { id: ROUTER_DELETE_CONFIRM_ACTION, title: "Delete the route" },
    { id: ROUTER_BACK_ACTION, title: "Go back one screen" },
  ],
};

export default routerPlugin;
