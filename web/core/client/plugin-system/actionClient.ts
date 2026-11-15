// One POST path for every plugin-action surface (page buttons, contribution
// menus, keyboard shortcuts). A declared confirm travels byte-identically;
// instant actions (per the plugin-actions PRD) send none.

import type { ActionDescriptor } from "./contract.ts";

export interface ActionPostResult {
  ok?: boolean;
  requestId?: string;
  error?: string;
  relayed?: boolean;
}

export interface ActionPostOutcome {
  status: number;
  data: ActionPostResult;
}

/**
 * What to tell the user when an action does not take effect.
 *
 * A plugin action can fail in ways the browser cannot see: the plugin may be
 * inactive (404), the host may refuse the submission (403/409), or the action
 * may be relayed to an extension that does not know it — a session started
 * before the plugin's current build. Silence is the worst answer, because the
 * click looks broken rather than stale.
 */
export function actionFailureMessage(status: number, data: ActionPostResult): string {
  if (status === 404) {
    return "This plugin is not active in this session, so the click did nothing. Start a new session and retry. If the web server was restarted twice within a minute, the plugin kernel is in safe mode until the next restart.";
  }
  if (status === 403) return "The host refused this action (confirmation did not match). Reopen the dialog and try again.";
  if (status === 409) return "That action is still running; wait for it to finish before trying again.";
  if (data.error !== undefined && data.error !== "") return data.error;
  return "The action failed.";
}

/**
 * The action reached the session but produced no new view: the extension that
 * owns it is a build without this action (a session older than the plugin).
 */
export const NO_RESPONSE_MESSAGE =
  "The session did not respond. It may be running an older build of this extension — start a new session to pick up the current one.";

export async function postPluginAction(
  sessionId: string,
  pluginId: string,
  action: Pick<ActionDescriptor, "id" | "confirm"> & { values?: Record<string, string> },
): Promise<ActionPostOutcome> {
  const response = await fetch("/api/plugins/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      pluginId,
      actionId: action.id,
      ...(action.confirm !== undefined ? { confirm: action.confirm } : {}),
      ...(action.values !== undefined ? { values: action.values } : {}),
    }),
  });
  const data = (await response.json().catch(() => ({}))) as ActionPostResult;
  return { status: response.status, data };
}

/**
 * Match a declared keybinding ("Alt+M", "Ctrl+Shift+P") against a keydown.
 * `code` is checked alongside `key` so layouts where the modifier types a
 * character (macOS Option+M is "µ") still match the physical key.
 */
export function actionKeybindingMatches(binding: string, event: KeyboardEvent): boolean {
  const parts = binding.split("+");
  const key = parts.pop();
  if (!key) return false;
  const modifiers = new Set(parts);
  const pressed: Record<"Alt" | "Ctrl" | "Meta" | "Shift", boolean> = {
    Alt: event.altKey,
    Ctrl: event.ctrlKey,
    Meta: event.metaKey,
    Shift: event.shiftKey,
  };
  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const keyMatches = eventKey === key || event.code === `Key${key}` || event.code === `Digit${key}`;
  if (!keyMatches) return false;
  // Every declared modifier is pressed, and no undeclared one is.
  const undeclared = (Object.keys(pressed) as Array<keyof typeof pressed>).filter(
    (mod) => pressed[mod] && !modifiers.has(mod),
  );
  if (undeclared.length > 0) return false;
  return [...modifiers].every((mod) => pressed[mod as keyof typeof pressed]);
}

/** A shortcut must not steal keys from a field the user is typing in. */
export function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}
