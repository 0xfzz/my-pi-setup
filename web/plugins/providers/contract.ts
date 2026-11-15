/**
 * The providers bridge contract: the plugin id, the web command name and the
 * wizard's action ids that the "providers" pi extension and this web
 * descriptor share.
 *
 *   - extensions/providers.ts imports these to register the web command,
 *     publish the wizard's step and resolve an answer from the action request,
 *   - web/plugins/providers/descriptor.ts imports these to declare the plugin
 *     and its actions, which is what lets the server relay them at all.
 *
 * The plugin exists for one reason: the model picker's "+ Add models" entry
 * dispatches a `web_command` and the wizard's answers arrive as plugin
 * actions. Both need a plugin id the host knows.
 */

export const PROVIDERS_PLUGIN_ID = "providers";

/** The web command the picker's "+ Add models" entry dispatches. */
export const PROVIDERS_WEB_COMMAND = "provider";

/** Answer the current step; the value travels in `values.value`. */
export const PROVIDERS_NEXT_ACTION = "provider-next";
/** Replace the provider list with a fresh connection wizard. */
export const PROVIDERS_ADD_ACTION = "provider-add";
/** Open or act on a configured provider; state and validation stay in the plugin. */
export const PROVIDERS_MANAGE_ACTION = "provider-manage";
/** Go back one step, keeping every answer. */
export const PROVIDERS_BACK_ACTION = "provider-back";
/** Close the wizard; nothing is written. */
export const PROVIDERS_CANCEL_ACTION = "provider-cancel";

/** The wizard's one field per step. */
export const PROVIDERS_FIELD = "value";

/**
 * The dialog id of a step.
 *
 * A step is a new id, which is what makes the client's form reset per step; a
 * re-publish of the same id keeps the typed answer, which is how a refused
 * value is corrected in place.
 */
export function providersDialogId(step: string): string {
  return `provider-wizard:${step}`;
}

/** The dialog that reports what was saved. */
export const PROVIDERS_SAVED_DIALOG = providersDialogId("saved");
/** The dialog that reports an unreadable models.json. */
export const PROVIDERS_FILE_DIALOG = providersDialogId("file");
