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

export async function postPluginAction(
  sessionId: string,
  pluginId: string,
  action: Pick<ActionDescriptor, "id" | "confirm">,
): Promise<ActionPostOutcome> {
  const response = await fetch("/api/plugins/action", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      pluginId,
      actionId: action.id,
      ...(action.confirm !== undefined ? { confirm: action.confirm } : {}),
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
