/**
 * The router bridge contract: the plugin ids, the web command name and the
 * action ids that the `account-router` pi extension and this web descriptor
 * share.
 *
 *   - extensions/account-router.ts imports these to register the web command,
 *     publish the panel's view and the editor's screen, and apply an answer,
 *   - web/plugins/router/descriptor.ts imports these to declare the plugins and
 *     their actions, which is what lets the server relay them at all,
 *   - lib/provider/router-web.ts imports these to build the views, because the
 *     view and the action that leaves it must agree on one id.
 *
 * Neither side imports the other: this file is the whole seam.
 */

/**
 * The panel plugin: the right sidebar's route visualization.
 *
 * A host keeps exactly one view per plugin id, and the panel renders that view.
 * The editor is therefore its own plugin (`ROUTER_EDITOR_PLUGIN_ID`) rather than
 * a second view here — otherwise publishing an editor screen would replace the
 * panel's table and the panel would go unavailable mid-edit.
 */
export const ROUTER_PLUGIN_ID = "router";

/**
 * The editor plugin: the dialog screens, embedded in the shared settings pane.
 *
 * Dialog-only, and named by the announced command's `settingsPlugin`, which is
 * what makes the host render it in the model-settings pane instead of as a
 * floating modal.
 */
export const ROUTER_EDITOR_PLUGIN_ID = "router-editor";

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
/**
 * The panel's only action: re-read the config files.
 *
 * A visualization cannot offer "edit route 3" — a list row carries no action —
 * and it must not offer "open the editor" either: the editor is the settings
 * pane's publisher, which the host suppresses outside that pane, so an action
 * that published it from here would do nothing visible. Reloading is the one
 * thing the panel can honestly do alone, and it is what a hand-edited config
 * needs.
 */
export const ROUTER_RELOAD_ACTION = "router-reload";

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
