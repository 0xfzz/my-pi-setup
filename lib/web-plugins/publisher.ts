import { WEB_PLUGIN_VIEW_EVENT, validateView } from "./view.ts";

export interface PublishWebViewTarget {
  events?: {
    emit(channel: string, data: unknown): void;
  };
}

export interface PublishWebViewResult {
  ok: boolean;
  warnings?: string[];
  error?: string;
}

export function publishWebView(
  pi: PublishWebViewTarget | null | undefined,
  pluginId: string,
  view: unknown,
): PublishWebViewResult {
  try {
    if (!pluginId || typeof pluginId !== "string") {
      return { ok: false, error: "pluginId must be a non-empty string" };
    }

    const result = validateView(view);
    if (!result.ok) {
      return { ok: false, error: result.error };
    }

    try {
      if (pi && pi.events && typeof pi.events.emit === "function") {
        pi.events.emit(WEB_PLUGIN_VIEW_EVENT, { pluginId, view: result.view });
      }
    } catch {
      // Never throw into the caller if event emission fails.
    }

    return {
      ok: true,
      ...(result.warnings && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
