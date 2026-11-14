/**
 * The ask-user bridge contract: the plugin id and the three fixed action ids
 * the "ask-user" pi extension and this web descriptor share.
 *   - extensions/ask-user.ts imports these to publish the dialog view and
 *     resolve the user's answer from the action request,
 *   - web/plugins/ask-user/descriptor.ts imports these to declare them.
 */
export const ASK_USER_PLUGIN_ID = "ask-user";
/** Pick one of the offered choices; the clicked option's label travels in `confirm`. */
export const ASK_USER_OPTION_ACTION = "answer-option";
/** Submit the dialog input's typed text; the text travels in `confirm`. */
export const ASK_USER_TEXT_ACTION = "answer-text";
/** Cancel the dialog without answering. */
export const ASK_USER_CANCEL_ACTION = "cancel";
