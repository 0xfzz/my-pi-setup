/**
 * The bridge extension: observes other pi extensions through pi's own event
 * bus and re-expresses their surfaces as protocol envelopes. It imports no
 * web code, needs no cooperation from the observed extensions and can be
 * disabled without touching them.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT } from "../web/core/plugin-contracts/actions.ts";
import { WEB_MODELS_CHANGED_EVENT, WEB_UI_EVENT } from "../web/core/plugin-contracts/ui-event-models.ts";
import { WEB_PLUGIN_VIEW_EVENT } from "../web/core/plugin-contracts/view.ts";
import { WEB_PLUGIN_COMMANDS_EVENT, WEB_PLUGIN_WEB_COMMAND_EVENT } from "../web/core/plugin-contracts/web-commands.ts";
import {
  BRIDGE_MESSAGE_EVENT,
  publishBridgeMessage,
  type BridgePublishTarget,
} from "../web/core/protocol/publisher.ts";
import type { MessageName } from "../web/core/protocol/catalog.ts";
import {
  activePluginMessageRegistry,
  BRIDGE_RELAY_MARKER,
  validationMarkOf,
  type PluginMessageRegistry,
  type PublishOptions,
} from "../web/core/protocol/index.ts";

export const BRIDGE_EXTENSION_ID = "bridge";

const BRIDGED_MARKER = BRIDGE_RELAY_MARKER;

export interface BridgeExtensionOptions {
  readonly registry?: PluginMessageRegistry;
}

function markedPayload(payload: unknown): unknown {
  if (payload !== null && typeof payload === "object" && !Array.isArray(payload)
    && Object.hasOwn(payload, BRIDGED_MARKER)) return undefined;
  return payload === null || typeof payload !== "object" || Array.isArray(payload)
    ? { value: payload, [BRIDGED_MARKER]: true }
    : { ...payload, [BRIDGED_MARKER]: true };
}

/** The bus events that already carry extension UI; no cooperation required. */
const UI_MESSAGE_NAMES: Record<string, MessageName> = {
  "ui.working.changed": "ui.working.changed",
  "ui.status.changed": "ui.status.changed",
  "ui.widget.changed": "ui.widget.changed",
  "ui.custom.changed": "ui.custom.changed",
  "ui.title.changed": "ui.title.changed",
  "ui.editor.changed": "ui.editor.changed",
  "ui.view.changed": "ui.view.changed",
  "ui.layout.changed": "ui.layout.changed",
  "ui.session.lifecycle": "ui.session.lifecycle",
  "ui.plugin.action-requested": "ui.plugin.action-requested",
  "ui.notify": "ui.notify",
};

export default function bridgeExtension(pi: ExtensionAPI, options: BridgeExtensionOptions = {}): () => void {
  const events = (pi as unknown as BridgePublishTarget).events;
  const unsubscribes: Array<() => void> = [];
  const listen = (channel: string, handler: (raw: unknown) => void): void => {
    const off = events?.on?.(channel, handler);
    if (off !== undefined) unsubscribes.push(off);
  };
  let sequence = 0;
  const emit = (sourceId: string, name: string, payload: unknown, publishOptions: PublishOptions = {}): void => {
    const marked = markedPayload(payload);
    publishBridgeMessage(pi as unknown as BridgePublishTarget, { type: "extension", id: sourceId }, name, marked ?? payload, `${sourceId}:${name}:${++sequence}`, publishOptions);
  };

  listen(WEB_UI_EVENT, (raw: unknown) => {
    const event = raw as { sourceKey?: unknown; type?: unknown; payload?: unknown };
    const name = typeof event.type === "string" ? UI_MESSAGE_NAMES[event.type] : undefined;
    if (name === undefined) return;
    emit(typeof event.sourceKey === "string" && event.sourceKey !== "" ? event.sourceKey : BRIDGE_EXTENSION_ID, name, event.payload ?? {});
  });
  listen(WEB_PLUGIN_VIEW_EVENT, (raw: unknown) => {
    const view = raw as { pluginId?: unknown; view?: unknown };
    if (typeof view.pluginId === "string") emit(view.pluginId, "ui.view.changed", view.view ?? {});
  });
  listen(WEB_PLUGIN_ACTION_REQUEST_EVENT, (raw: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "ui.plugin.action-requested", raw ?? {});
  });
  listen(WEB_PLUGIN_COMMANDS_EVENT, (raw: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "extension.commands.changed", raw ?? {});
  });
  listen(WEB_MODELS_CHANGED_EVENT, () => {
    emit(BRIDGE_EXTENSION_ID, "models.changed", {});
  });
  listen(WEB_PLUGIN_WEB_COMMAND_EVENT, (raw: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "extension.web-command.dispatch", raw ?? {});
  });
  listen(BRIDGE_MESSAGE_EVENT, (raw: unknown) => {
    // Opt-in publishers already carry an envelope; re-emit it with this
    // extension's attribution so a consumer can filter one source id.
    const envelope = raw as { source?: { id?: unknown; type?: unknown }; name?: unknown; payload?: unknown };
    const payload = envelope.payload;
    const isMarked = payload !== null && typeof payload === "object" && !Array.isArray(payload)
      && Object.hasOwn(payload, BRIDGED_MARKER);
    if (isMarked || typeof envelope.name !== "string") return;
    const source = typeof envelope.source?.id === "string" ? envelope.source.id : BRIDGE_EXTENSION_ID;
    const registry = options.registry ?? activePluginMessageRegistry();
    const name = envelope.name;
    const mark = validationMarkOf(payload);
    const markedCustom = mark?.name === name && mark.pluginId === source && name.startsWith(`${source}.`);
    const custom = registry?.lookup(name);
    if (custom !== undefined || markedCustom) {
      if (custom !== undefined) {
        if (envelope.source?.type !== "extension" && envelope.source?.type !== "plugin") return;
        if (source !== custom.pluginId) return;
        if (registry === undefined || !registry.validatePayload(name, payload).ok) return;
      } else if (!markedCustom) return;
      emit(source, name, payload, { registry, trustMark: registry === undefined });
      return;
    }
    emit(source, name as MessageName, payload);
  });

  unsubscribes.push(pi.on("tool_execution_start", (event: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "tool.execution.changed", { kind: "tool_execution_start", event });
  }));
  unsubscribes.push(pi.on("tool_execution_update", (event: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "tool.execution.changed", { kind: "tool_execution_update", event });
  }));
  unsubscribes.push(pi.on("tool_execution_end", (event: unknown) => {
    emit(BRIDGE_EXTENSION_ID, "tool.execution.changed", { kind: "tool_execution_end", event });
  }));

  return () => {
    for (const off of unsubscribes) off();
    unsubscribes.length = 0;
  };
}
