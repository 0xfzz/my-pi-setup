/**
 * Plugin → browser publish seam: how a server-half plugin puts something on
 * the user's screen.
 *
 * A pi extension publishes views through the session bus (`publishWebView`).
 * A plugin's server half runs in the web server process and has no bus, so
 * before this seam the only way to reach the browser was to mount a route and
 * let the client poll it. `ctx.ui` closes that gap with the same destination
 * the bus uses — the unified per-session store — so one browser surface has
 * one source of truth whichever side published it.
 *
 * The split of responsibility is deliberate:
 *
 *   - this registry owns the *gate* (`ui.publish`), the source key (so the
 *     store's per-producer rate limit applies to the plugin, not the host),
 *     and the teardown bookkeeping;
 *   - the sink owns *validation and storage* — the real one is
 *     `web/core/server/plugin-views.ts` + `ui-store.ts`, the same pair the
 *     extension path goes through, so a plugin cannot publish a shape a
 *     browser would have to guess at.
 *
 * Teardown clears what can be cleared. Status and widget entries have a
 * documented null tombstone, so a deactivated plugin's line disappears.
 * A view has none: the host only serves a descriptor for a live plugin, so a
 * disabled plugin's view stops being rendered without needing a delete.
 */
import { assertGranted, parseCapability, type Capability } from "./capabilities.ts";
import type { WebUiType } from "../ui-event-models.ts";
import type { WebView } from "../view.ts";

export type NotificationLevel = "info" | "warning" | "error";

/** Where the host's store lives. Absent in a kernel-only test. */
export interface PluginUiSink {
  publish(sessionId: string, type: WebUiType, payload: unknown, sourceKey: string): boolean;
}

export interface PluginUiOwner {
  pluginId: string;
  grants: readonly Capability[];
}

/** One entry a plugin published that deactivation can tombstone. */
interface Clearable {
  sessionId: string;
  type: "ui.status.changed" | "ui.widget.changed";
}

export class PluginUiRegistry {
  private sink: PluginUiSink | null = null;
  /** pluginId → `${sessionId}/${type}` → the entry to clear on deactivate. */
  private readonly published = new Map<string, Map<string, Clearable>>();

  /** Attach the host's store. Until this is called, publishes are refused. */
  attach(sink: PluginUiSink): void {
    this.sink = sink;
  }

  /** Publish a view for one session. The plugin's declared surface renders it. */
  publishView(owner: PluginUiOwner, sessionId: string, view: WebView): boolean {
    return this.deliver(owner, "ui.view.changed", sessionId, { pluginId: owner.pluginId, view });
  }

  /** A transient toast. The host keeps a bounded, expiring list per session. */
  notify(owner: PluginUiOwner, sessionId: string, message: string, level: NotificationLevel = "info"): boolean {
    return this.deliver(owner, "ui.notify", sessionId, { message, level });
  }

  /** This plugin's line in the status area; `null` removes it. */
  setStatus(owner: PluginUiOwner, sessionId: string, text: string | null): boolean {
    return this.deliver(owner, "ui.status.changed", sessionId, { key: owner.pluginId, text }, text === null);
  }

  /** This plugin's widget lines; `null` removes the widget. */
  setWidget(
    owner: PluginUiOwner,
    sessionId: string,
    lines: string[] | null,
    placement: "aboveEditor" | "belowEditor" = "belowEditor",
  ): boolean {
    return this.deliver(owner, "ui.widget.changed", sessionId, { key: owner.pluginId, lines, placement }, lines === null);
  }

  /**
   * Clear what this plugin left on screen and forget its bookkeeping. Called on
   * deactivate, rollback and quarantine.
   */
  removeOwner(pluginId: string): number {
    const entries = this.published.get(pluginId);
    this.published.delete(pluginId);
    if (entries === undefined || this.sink === null) return entries?.size ?? 0;
    for (const entry of entries.values()) {
      const payload = entry.type === "ui.status.changed"
        ? { key: pluginId, text: null }
        : { key: pluginId, lines: null, placement: "belowEditor" };
      try {
        this.sink.publish(entry.sessionId, entry.type, payload, pluginId);
      } catch {
        // Clearing is best effort: a torn-down plugin must not fail teardown.
      }
    }
    return entries.size;
  }

  /** The sink is the gate's counterpart; a missing one is a host wiring bug, not a plugin error. */
  private deliver(
    owner: PluginUiOwner,
    type: WebUiType,
    sessionId: string,
    payload: Record<string, unknown>,
    clearing = false,
  ): boolean {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    const requested = parseCapability("ui.publish");
    if (!requested.ok) return false;
    assertGranted(owner.pluginId, owner.grants, requested.value);
    if (this.sink === null) return false;

    const accepted = this.sink.publish(sessionId, type, payload, owner.pluginId);
    if (!accepted) return false;
    this.remember(owner.pluginId, type, sessionId, clearing);
    return true;
  }

  private remember(pluginId: string, type: WebUiType, sessionId: string, clearing: boolean): void {
    if (type !== "ui.status.changed" && type !== "ui.widget.changed") return;
    const entries = this.published.get(pluginId) ?? new Map<string, Clearable>();
    const key = `${sessionId}/${type}`;
    if (clearing) entries.delete(key);
    else entries.set(key, { sessionId, type });
    if (entries.size === 0) this.published.delete(pluginId);
    else this.published.set(pluginId, entries);
  }
}
