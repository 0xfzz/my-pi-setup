/** Direct binding for sessions hosted inside the web server process. */
import { createSessionAdapters, type SessionSurface } from "../../adapters/session.ts";
import type { DirectorySurface } from "../../adapters/directory.ts";
import { piApiAdapters } from "../../adapters/pi-api.ts";
import type { ProtocolAdapter } from "../../adapters/types.ts";
import { lookupMessage } from "../catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { bridgeError } from "../errors.ts";
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
import type { BindingName, BindingOptions, BindingReply, ProtocolBinding } from "./types.ts";

export interface InProcessOptions extends BindingOptions {
  readonly session: SessionSurface;
  readonly snapshot?: () => unknown;
  readonly directory?: DirectorySurface;
  readonly events?: () => readonly BridgeEnvelope[];
}

/** Adapters are looked up by catalog name; unknown names are never guessed. */
export function adapterFor(name: string, options: InProcessOptions): ProtocolAdapter | undefined {
  if (Object.hasOwn(piApiAdapters, name)) {
    return piApiAdapters[name as keyof typeof piApiAdapters];
  }
  const sessionAdapters = createSessionAdapters({
    ...options.session,
    snapshot: options.session.snapshot ?? options.snapshot,
    resync: options.session.resync ?? (() => options.snapshot?.() ?? {}),
  }, options.directory);
  if (Object.hasOwn(sessionAdapters, name)) return sessionAdapters[name];
  if (["ui.snapshot", "session.resync", "plugin-state.snapshot"].includes(name)) {
    return async () => ({ ok: true, value: options.snapshot?.() ?? {} });
  }
  if (lookupMessage(name)?.kind === "event") {
    return async () => ({ ok: true, value: { accepted: true } });
  }
  if (name === "plugin.action.submit") {
    // Action values are revalidated by the owning extension (EB5); the
    // binding only transports the envelope.
    return async () => ({ ok: true, value: { queued: true } });
  }
  return undefined;
}

export interface DispatchOptions {
  readonly handshake: Handshake;
  readonly options: InProcessOptions;
  readonly envelope: BridgeEnvelope;
  readonly signal: AbortSignal;
  readonly sequence: number;
  readonly cursor: string;
}

/** One adapter call, with the sequence/cursor the host stamped on its reply. */
export async function dispatchAdapter({ handshake, options, envelope, signal, sequence, cursor }: DispatchOptions): Promise<BindingReply> {
  const message = messageFor(envelope);
  if (message === undefined) {
    return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${envelope.name}"`) };
  }
  // gate() checks the manifest slice from the handshake before capability grants.
  const denied = gate(message, envelope, handshake, options.audit);
  if (denied !== undefined) return { ok: false, error: denied };
  if (message.kind === "capability") return reply(envelope, { acknowledged: true }, { sequence, cursor });
  const adapter = adapterFor(envelope.name, options);
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

export function createInProcessBinding(options: InProcessOptions): ProtocolBinding {
  let handshake: Handshake | undefined;
  let sequence = 0;
  let cursor = options.initialCursor ?? "0";
  const buffered: BridgeEnvelope[] = [];

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
      const parsed = parseEnvelope(envelope);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.envelope.version !== BRIDGE_PROTOCOL_VERSION) {
        return { ok: false, error: versionMismatch(parsed.envelope.version) };
      }
      const attributed = attributedSource(parsed.envelope, handshake, "in-process");
      const message = messageFor(attributed);
      if (message === undefined) {
        return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${attributed.name}"`) };
      }
      const denied = gate(message, attributed, handshake, options.audit);
      if (denied !== undefined) return { ok: false, error: denied };

      sequence += 1;
      cursor = String(sequence);
      if (message.kind === "event") {
        buffered.push({ ...attributed, sequence, cursor });
      }
      return dispatchAdapter({ handshake, options, envelope: attributed, signal, sequence, cursor });
    },

    events(): readonly BridgeEnvelope[] {
      return options.events?.() ?? buffered;
    },

    close(): Promise<void> {
      handshake = undefined;
      return Promise.resolve();
    },
  };
}
