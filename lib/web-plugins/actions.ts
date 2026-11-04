export const WEB_PLUGIN_ACTION_REQUEST_EVENT = "web-plugin:action-request";

export const MAX_ACTIONS = 8;
export const ACTION_ID_REGEX = /^[a-z][a-z0-9-]*$/;

export interface ActionDescriptor {
  id: string;
  title: string;
  confirm: string;
}

export interface ActionRequestPayload {
  requestId: string;
  pluginId: string;
  actionId: string;
  sessionId: string;
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

    if (typeof raw.confirm !== "string" || raw.confirm.trim().length === 0) {
      return {
        ok: false,
        error: `Action "${raw.id}": confirm is missing or empty`,
      };
    }

    cleanActions.push({
      id: raw.id,
      title: raw.title,
      confirm: raw.confirm,
    });
  }

  return { ok: true, actions: cleanActions };
}
