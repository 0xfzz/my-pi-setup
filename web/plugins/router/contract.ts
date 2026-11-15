/**
 * The router bridge contract: the plugin id, the web command name and the
 * action ids that the `account-router` pi extension and this web descriptor
 * share.
 *
 *   - extensions/account-router.ts imports these to register the web command,
 *     publish the editor's screen and apply an answer,
 *   - web/plugins/router/descriptor.ts imports these to declare the plugin and
 *     its actions, which is what lets the server relay them at all,
 *   - lib/provider/router-web.ts imports these to build the screens, because
 *     the screen and the action that leaves it must agree on one id.
 *
 * Neither side imports the other: this file is the whole seam.
 */

export const ROUTER_PLUGIN_ID = "router";

/**
 * The web command the shared model-settings dialog dispatches for the "Router"
 * page. It is also the pi command name (`/router`), so the composer's palette
 * lists one entry rather than two.
 */
export const ROUTER_WEB_COMMAND = "router";

/** Open one route (or, with no `route` value, start a new one). */
export const ROUTER_OPEN_ACTION = "router-open";
/** Save the form on screen; the values carry every field. */
export const ROUTER_SAVE_ACTION = "router-save";
/** Go to the target picker, carrying the form's answers with it. */
export const ROUTER_TARGETS_ACTION = "router-targets";
/** Tick or untick one model in the target picker. */
export const ROUTER_TOGGLE_ACTION = "router-toggle";
/** Narrow the target picker to the models matching the filter field. */
export const ROUTER_FILTER_ACTION = "router-filter";
/** Ask before deleting the route on screen. */
export const ROUTER_DELETE_ACTION = "router-delete";
/** Delete, after the confirmation screen. */
export const ROUTER_DELETE_CONFIRM_ACTION = "router-delete-confirm";
/** One screen back; from the route list it closes the pane. */
export const ROUTER_BACK_ACTION = "router-back";

/** The form field names: one per answer the editor collects. */
export const ROUTER_NAME_FIELD = "name";
export const ROUTER_FILE_FIELD = "file";
export const ROUTER_METHOD_FIELD = "method";
export const ROUTER_WHEN_FIELD = "when";
/** The target picker's search box; it filters the list, it is not an answer. */
export const ROUTER_FILTER_FIELD = "filter";

/** Value names carried by a row click, rather than by a form. */
export const ROUTER_ROUTE_VALUE = "route";
export const ROUTER_MODEL_VALUE = "model";

/**
 * The dialog id of a screen.
 *
 * A screen is a new id, which is what makes the client reset the form when the
 * editor moves on; a re-publish of the same id keeps the typed answers, which
 * is how a refused value is corrected in place.
 */
export function routerDialogId(screen: string): string {
  return `router-editor:${screen}`;
}
