import type { WebPluginDescriptor } from "../../core/plugin-contracts/descriptor.ts";
import {
  ROUTER_BACK_ACTION,
  ROUTER_DELETE_ACTION,
  ROUTER_DELETE_CONFIRM_ACTION,
  ROUTER_EDITOR_PLUGIN_ID,
  ROUTER_FILTER_ACTION,
  ROUTER_OPEN_ACTION,
  ROUTER_PLUGIN_ID,
  ROUTER_RELOAD_ACTION,
  ROUTER_SAVE_ACTION,
  ROUTER_TARGETS_ACTION,
  ROUTER_TOGGLE_ACTION,
} from "./contract.ts";

/**
 * The route table as a right-sidebar panel.
 *
 * Panel-only: the host renders the `router` plugin's published view read-only in
 * the side panel, so this is a visualization by construction. There is no `ui`
 * contribution because the panel is its only home — a `sidebar` surface is what
 * makes a plugin a panel, and a slot placement would have nowhere to mount (the
 * shell never mounts the sidebar region as an inline slot).
 */
export const routerPlugin: WebPluginDescriptor = {
  id: ROUTER_PLUGIN_ID,
  extension: "account-router",
  title: "Router",
  icon: "sliders",
  description:
    "The route table: each virtual model's chain, its routing method and trigger, and which target still holds the prompt cache. Read-only — routes are edited in the shared model dialog.",
  surfaces: [{ kind: "sidebar" }],
  actions: [
    { id: ROUTER_RELOAD_ACTION, title: "Re-read the router config files" },
  ],
};

/**
 * The route editor, embedded in the shared model-settings dialog's "Router" page.
 *
 * A separate plugin from the panel because a host keeps exactly one view per
 * plugin id: an editor screen published under `router` would replace the panel's
 * table and the panel would go unavailable mid-edit.
 */
export const routerEditorPlugin: WebPluginDescriptor = {
  id: ROUTER_EDITOR_PLUGIN_ID,
  extension: "account-router",
  title: "Route editor",
  icon: "sliders",
  description:
    "Create, order, re-policy and delete routes through the shared dialog: name and file, routing method, re-decide trigger, and the model chain with its prompt-cache warmth.",
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
