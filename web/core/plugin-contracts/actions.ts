export const WEB_PLUGIN_ACTION_REQUEST_EVENT = "web-plugin:action-request";

export const MAX_ACTIONS = 8;
export const ACTION_ID_REGEX = /^[a-z][a-z0-9-]*$/;

/**
 * One to three modifiers plus a single letter or digit: "Alt+M", "Ctrl+Shift+P".
 * A bare key or a trailing extra key is rejected, and so is every lowercase form.
 */
export const ACTION_KEYBINDING_REGEX = /^(?:(?:Alt|Ctrl|Meta|Shift)\+){1,3}(?:[A-Z]|[0-9])$/;

export interface ActionDescriptor {
  id: string;
  title: string;
  /**
   * Exact string the user must type before the action is submitted. Optional
   * only for actions a plugin-actions PRD names as instant (reversible,
   * low blast radius); a declared confirm is still enforced byte-identically.
   */
  confirm?: string;
  /** Host-registered keyboard shortcut that submits this action directly. */
  keybinding?: string;
}

export interface ActionRequestPayload {
  requestId: string;
  pluginId: string;
  actionId: string;
  sessionId: string;
  /**
   * The dialog's typed answer, carried only by instant actions (no declared
   * confirm): an ask-style dialog submits the input text or the clicked
   * option label as the value. A DECLARED confirm is the byte-match check
   * and is never relayed.
   */
  confirm?: string;
  /**
   * The dialog form's answers, keyed by `DialogField.name`. Present only when
   * the dialog declared `fields` and the action submits them; the single
   * `confirm` value stays the label/typed-text channel, so an extension can
   * read either shape without a mode switch.
   */
  values?: Record<string, string>;
}

/** A submitted form carries a bounded number of bounded strings. */
export const MAX_ACTION_VALUES = 16;
export const MAX_ACTION_VALUE_CHARS = 4000;

/**
 * Validate a form submission from the browser.
 *
 * The browser is untrusted: keys must be plain field names and every value a
 * bounded string, so an extension can read `values[step]` without defending
 * against a prototype key or a megabyte payload.
 */
export function validateActionValues(input: unknown): { ok: true; values?: Record<string, string> } | { ok: false; error: string } {
  if (input === undefined) return { ok: true };
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "values must be an object" };
  }
  const entries = Object.entries(input as Record<string, unknown>);
  if (entries.length > MAX_ACTION_VALUES) {
    return { ok: false, error: `values cannot exceed ${MAX_ACTION_VALUES} entries` };
  }
  const values: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(key)) {
      return { ok: false, error: `values key "${key}" must be a plain field name` };
    }
    if (typeof value !== "string") return { ok: false, error: `values["${key}"] must be a string` };
    if (value.length > MAX_ACTION_VALUE_CHARS) {
      return { ok: false, error: `values["${key}"] cannot exceed ${MAX_ACTION_VALUE_CHARS} characters` };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

export type ValidateActionsResult =
  | { ok: true; actions: ActionDescriptor[] }
  | { ok: false; error: string };

export function validateActions(input: unknown): ValidateActionsResult {
  if (!Array.isArray(input)) {
    return { ok: false, error: "actions must be an array" };
  }

  if (input.length > MAX_ACTIONS) {
    return {
      ok: false,
      error: `actions cannot exceed ${MAX_ACTIONS} actions (got ${input.length})`,
    };
  }

  const cleanActions: ActionDescriptor[] = [];
  for (let i = 0; i < input.length; i++) {
    const item = input[i];
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      return { ok: false, error: `Action at index ${i} must be an object` };
    }

    const raw = item as Record<string, unknown>;
    const actionId =
      typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : `index ${i}`;

    if (typeof raw.id !== "string" || !ACTION_ID_REGEX.test(raw.id)) {
      return {
        ok: false,
        error: `Action "${actionId}": id must match ^[a-z][a-z0-9-]*$`,
      };
    }

    if (typeof raw.title !== "string" || raw.title.trim().length === 0) {
      return {
        ok: false,
        error: `Action "${raw.id}": title is missing or empty`,
      };
    }

    if (raw.confirm !== undefined) {
      if (typeof raw.confirm !== "string" || raw.confirm.trim().length === 0) {
        return {
          ok: false,
          error: `Action "${raw.id}": confirm is missing or empty`,
        };
      }
    }

    if (raw.keybinding !== undefined) {
      if (typeof raw.keybinding !== "string" || !ACTION_KEYBINDING_REGEX.test(raw.keybinding)) {
        return {
          ok: false,
          error: `Action "${raw.id}": keybinding must look like Alt+M (one to three modifiers, then one letter or digit)`,
        };
      }
    }

    cleanActions.push({
      id: raw.id,
      title: raw.title,
      ...(typeof raw.confirm === "string" ? { confirm: raw.confirm } : {}),
      ...(typeof raw.keybinding === "string" ? { keybinding: raw.keybinding } : {}),
    });
  }

  return { ok: true, actions: cleanActions };
}
