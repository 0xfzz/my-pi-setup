/** Session attach binding: envelopes ride the existing TUI command channel. */
import type { BridgeCommand } from "../../server/bridge.ts";
import type { BridgeEnvelope } from "../envelope.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION } from "../version.ts";
import { bridgeCommandSurface } from "../../adapters/session.ts";
import { createInProcessBinding } from "./in-process.ts";
import type { BindingOptions, ProtocolBinding } from "./types.ts";

/** The slice of an attached session the binding needs (BridgeConnection-shaped). */
export interface AttachConnection {
  sendCommand(command: BridgeCommand): void;
  getCommands?(): Array<{ name: string; description?: string }>;
  getModels?(): { current?: { provider: string; id: string }; models: Array<{ provider: string; id: string }> };
  getTreeNodes?(): unknown[];
  subscribe?(listener: (event: unknown) => void): () => void;
}

function attachedEventName(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const type = (raw as { type?: unknown }).type;
  if (typeof type !== "string") return undefined;
  if (type === "web_ui_event") {
    const eventType = (raw as { event?: { type?: unknown } }).event?.type;
    return typeof eventType === "string" && eventType.startsWith("ui.") ? eventType : undefined;
  }
  if (type === "web_plugin_view") return "ui.view.changed";
  if (type === "web_commands" || type === "web_models" || type === "web_tree" || type === "bridge_attached") {
    return "session.attach.attached";
  }
  return undefined;
}

function toEnvelope(raw: unknown, sessionId: string | undefined, sequence: number): BridgeEnvelope | undefined {
  const name = attachedEventName(raw);
  if (name === undefined) return undefined;
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: "event",
    name: name as BridgeEnvelope["name"],
    messageId: `attach-${sequence}`,
    ...(sessionId === undefined ? {} : { sessionId }),
    source: { type: "extension", id: "session-attach" },
    timestamp: 0,
    sequence,
    payload: raw,
  };
}

export function createSessionAttachBinding(options: BindingOptions, connection: AttachConnection): ProtocolBinding {
  const buffered: BridgeEnvelope[] = [];
  const unsubscribe = connection.subscribe?.((event) => {
    const envelope = toEnvelope(event, options.sessionId, buffered.length + 1);
    if (envelope !== undefined) buffered.push(envelope);
  });
  const delegate = createInProcessBinding({
    ...options,
    name: "session-attach",
    session: bridgeCommandSurface((command) => connection.sendCommand(command)),
    snapshot: () => ({
      commands: connection.getCommands?.() ?? [],
      models: connection.getModels?.() ?? null,
      tree: connection.getTreeNodes?.() ?? [],
    }),
  });

  return {
    name: "session-attach",
    hello: (hello) => delegate.hello(hello),
    invoke: (envelope, signal) => delegate.invoke(envelope, signal),
    events: () => buffered,
    close: () => {
      unsubscribe?.();
      return delegate.close();
    },
  };
}
