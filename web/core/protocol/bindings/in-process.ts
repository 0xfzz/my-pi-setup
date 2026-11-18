/** Direct binding for sessions hosted inside the web server process. */
import { createSessionAdapters, type SessionSurface } from "../../adapters/session.ts";
import type { DirectorySurface } from "../../adapters/directory.ts";
import { piApiAdapters } from "../../adapters/pi-api.ts";
import type { ProtocolAdapter } from "../../adapters/types.ts";
import {
  activePluginMessageRegistry,
  payloadForDelivery,
  stripRelayMarker,
} from "../index.ts";
import { lookupMessage, MESSAGE_NAMES } from "../catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { bridgeError, type BridgeError } from "../errors.ts";
import { BRIDGE_PROTOCOL_VERSION, versionMismatch, type Hello, type HelloAck } from "../version.ts";
import {
  attributedSource,
  gate,
  handshakeFor,
  handshakeRequired,
  messageFor,
  reply,
  type Handshake,
} from "./shared.ts";
import type { BindingName, BindingOptions, BindingReply, ValidatedProtocolBinding } from "./types.ts";

export interface InProcessOptions extends BindingOptions {
  readonly session: SessionSurface;
  readonly snapshot?: () => unknown;
  readonly directory?: DirectorySurface;
  readonly events?: () => readonly BridgeEnvelope[];
}

/** Adapter tables depend only on the binding's immutable surface options. */
function adaptersFor(options: InProcessOptions): Record<string, ProtocolAdapter> {
  const adapters: Record<string, ProtocolAdapter> = {
    ...piApiAdapters,
    ...createSessionAdapters({
      ...options.session,
      snapshot: options.session.snapshot ?? options.snapshot,
      resync: options.session.resync ?? (() => options.snapshot?.() ?? {}),
    }, options.directory),
  };
  for (const name of ["ui.snapshot", "session.resync", "plugin-state.snapshot"]) {
    adapters[name] ??= async () => ({ ok: true, value: options.snapshot?.() ?? {} });
  }
  for (const name of MESSAGE_NAMES) {
    if (lookupMessage(name)?.kind === "event") adapters[name] ??= async () => ({ ok: true, value: { accepted: true } });
  }
  adapters["plugin.action.submit"] ??= async () => ({ ok: true, value: { queued: true } });
  return adapters;
}

export function validatedEnvelope(envelope: BridgeEnvelope, options: BindingOptions): { ok: true; envelope: BridgeEnvelope } | { ok: false; error: BridgeError } {
  const registry = options.messageRegistry ?? activePluginMessageRegistry();
  if (registry?.lookup(envelope.name) === undefined) return { ok: true, envelope };
  const checked = registry!.validatePayload(envelope.name, stripRelayMarker(envelope.payload));
  if (!checked.ok) return { ok: false, error: checked.error };
  return { ok: true, envelope: { ...envelope, payload: payloadForDelivery(checked.value) } };
}

export interface DispatchOptions {
  readonly handshake: Handshake;
  readonly options: InProcessOptions;
  readonly adapters: Readonly<Record<string, ProtocolAdapter>>;
  readonly envelope: BridgeEnvelope;
  readonly signal: AbortSignal;
  readonly sequence: number;
  readonly cursor: string;
}

/** One adapter call, with the sequence/cursor the host stamped on its reply. */
export async function dispatchAdapter({ handshake, options, adapters, envelope, signal, sequence, cursor }: DispatchOptions): Promise<BindingReply> {
  const message = messageFor(envelope, options.messageRegistry);
  if (message === undefined) {
    return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${envelope.name}"`) };
  }
  // gate() checks the manifest slice from the handshake before capability grants.
  const denied = gate(message, envelope, handshake, options.audit);
  if (denied !== undefined) return { ok: false, error: denied };
  if (message.kind === "capability") return reply(envelope, { acknowledged: true }, { sequence, cursor });
  const registration = (options.messageRegistry ?? activePluginMessageRegistry())?.lookup(envelope.name);
  if (registration !== undefined) {
    if (registration.kind !== "command") return reply(envelope, envelope.payload, { sequence, cursor });
    if (options.pluginCommand === undefined) {
      return { ok: false, error: bridgeError("ADAPTER_UNAVAILABLE", `no command relay for "${envelope.name}"`) };
    }
    const relayed = await options.pluginCommand({ name: registration.name, pluginId: registration.pluginId, payload: envelope.payload });
    return reply(envelope, relayed.value, { sequence, cursor, ...(relayed.ok ? {} : { error: bridgeError("INTERNAL", `plugin command "${envelope.name}" was not relayed`) }) });
  }
  const adapter = adapters[envelope.name];
  if (adapter === undefined) {
    return { ok: false, error: bridgeError("ADAPTER_UNAVAILABLE", `no adapter for "${envelope.name}"`) };
  }
  const result = await adapter(
    { cwd: options.cwd, sessionId: options.sessionId, grantedCapabilities: options.grantedCapabilities },
    envelope.payload,
    signal,
  );
  return reply(envelope, result.ok ? result.value : null, {
    sequence,
    cursor,
    ...(result.ok ? {} : { error: result.error }),
  });
}

export function createInProcessBinding(options: InProcessOptions): ValidatedProtocolBinding {
  let handshake: Handshake | undefined;
  let sequence = 0;
  let cursor = options.initialCursor ?? "0";
  const buffered: BridgeEnvelope[] = [];
  const adapters = adaptersFor(options);

  const dispatch = async (active: Handshake, envelope: BridgeEnvelope, signal: AbortSignal): Promise<BindingReply> => {
    if (envelope.version !== BRIDGE_PROTOCOL_VERSION) {
      return { ok: false, error: versionMismatch(envelope.version) };
    }
    const attributed = attributedSource(envelope, active, "in-process");
    const message = messageFor(attributed, options.messageRegistry);
    if (message === undefined) {
      return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${attributed.name}"`) };
    }
    const denied = gate(message, attributed, active, options.audit);
    if (denied !== undefined) return { ok: false, error: denied };
    const checked = validatedEnvelope(attributed, options);
    if (!checked.ok) {
      options.audit?.({ source: attributed.source.id, capability: "VALIDATION_FAILED", message: attributed.name });
      return { ok: false, error: checked.error };
    }

    sequence += 1;
    cursor = String(sequence);
    if (message.kind === "event") {
      buffered.push({ ...checked.envelope, sequence, cursor });
    }
    return dispatchAdapter({ handshake: active, options, adapters, envelope: checked.envelope, signal, sequence, cursor });
  };

  const invokeUnchecked = (envelope: BridgeEnvelope, signal: AbortSignal): Promise<BindingReply> => {
    if (handshake === undefined) return Promise.resolve({ ok: false, error: handshakeRequired() });
    return dispatch(handshake, envelope, signal);
  };

  return {
    name: options.name as BindingName,

    hello(hello: Hello): Promise<BindingReply<HelloAck>> {
      const result = handshakeFor(hello, options);
      if (result.ok) {
        handshake = result.value;
        const { version, capabilities, bindings, sessionId, cursor: helloCursor } = result.value;
        return Promise.resolve({ ok: true, value: { version, capabilities, bindings, sessionId, cursor: helloCursor } });
      }
      return Promise.resolve(result);
    },

    async invoke(envelope: BridgeEnvelope, signal: AbortSignal = new AbortController().signal): Promise<BindingReply> {
      if (handshake === undefined) return { ok: false, error: handshakeRequired() };
      const parsed = parseEnvelope(envelope, options.messageRegistry?.names().map((entry) => entry.name));
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return dispatch(handshake, parsed.envelope, signal);
    },

    invokeValidated: invokeUnchecked,

    events(): readonly BridgeEnvelope[] {
      return options.events?.() ?? buffered;
    },

    close(): Promise<void> {
      handshake = undefined;
      return Promise.resolve();
    },
  };
}
