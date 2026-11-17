/** Direct binding for sessions hosted inside the web server process. */
import { createSessionAdapters, type SessionSurface } from "../../adapters/session.ts";
import { piApiAdapters } from "../../adapters/pi-api.ts";
import type { ProtocolAdapter } from "../../adapters/types.ts";
import { parseEnvelope, type BridgeEnvelope } from "../envelope.ts";
import { bridgeError, type BridgeError } from "../errors.ts";
import { BRIDGE_PROTOCOL_VERSION, versionMismatch, type Hello, type HelloAck } from "../version.ts";
import { gate, helloAck, messageFor, reply } from "./shared.ts";
import type { BindingName, BindingOptions, BindingReply, ProtocolBinding } from "./types.ts";

export interface InProcessOptions extends BindingOptions {
  readonly session: SessionSurface;
  readonly snapshot?: () => unknown;
  readonly events?: () => readonly BridgeEnvelope[];
}

function handshakeRequired(): BridgeError {
  return bridgeError("INTERNAL", "bridge.hello must precede commands and queries");
}

/** Adapters are looked up by catalog name; unknown names are never guessed. */
export function adapterFor(name: string, options: InProcessOptions): ProtocolAdapter | undefined {
  if (Object.hasOwn(piApiAdapters, name)) {
    return piApiAdapters[name as keyof typeof piApiAdapters];
  }
  const sessionAdapters = createSessionAdapters(options.session);
  if (Object.hasOwn(sessionAdapters, name)) return sessionAdapters[name];
  if (["ui.snapshot", "session.resync", "plugin-state.snapshot"].includes(name)) {
    return async () => ({ ok: true, value: options.snapshot?.() ?? {} });
  }
  if (name.startsWith("ui.") || name === "extension.commands.changed" || name === "models.changed") {
    return async () => ({ ok: true, value: { accepted: true } });
  }
  if (name === "plugin.action.submit") {
    // Action values are revalidated by the owning extension (EB5); the
    // binding only transports the envelope.
    return async () => ({ ok: true, value: { queued: true } });
  }
  return undefined;
}

export function createInProcessBinding(options: InProcessOptions): ProtocolBinding {
  let handshaken = false;
  let sequence = 0;
  let cursor = options.initialCursor ?? "0";
  const buffered: BridgeEnvelope[] = [];

  return {
    name: options.name as BindingName,

    hello(hello: Hello): Promise<BindingReply<HelloAck>> {
      const ack = helloAck(hello, options);
      if (ack.ok) handshaken = true;
      return Promise.resolve(ack);
    },

    async invoke(envelope: BridgeEnvelope, signal: AbortSignal = new AbortController().signal): Promise<BindingReply> {
      if (!handshaken) return { ok: false, error: handshakeRequired() };
      const parsed = parseEnvelope(envelope);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.envelope.version !== BRIDGE_PROTOCOL_VERSION) {
        return { ok: false, error: versionMismatch(parsed.envelope.version) };
      }
      const message = messageFor(parsed.envelope);
      if (message === undefined) {
        return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${parsed.envelope.name}"`) };
      }
      const denied = gate(message, parsed.envelope, options);
      if (denied !== undefined) return { ok: false, error: denied };
      if (message.kind === "capability") {
        return reply(parsed.envelope, { acknowledged: true });
      }
      if (message.kind === "event") {
        buffered.push(parsed.envelope);
        return reply(parsed.envelope, { accepted: true });
      }
      const adapter = adapterFor(parsed.envelope.name, options);
      if (adapter === undefined) {
        return { ok: false, error: bridgeError("ADAPTER_UNAVAILABLE", `no adapter for "${parsed.envelope.name}"`) };
      }
      const result = await adapter(
        { cwd: options.cwd, sessionId: options.sessionId, grantedCapabilities: options.grantedCapabilities },
        parsed.envelope.payload,
        signal,
      );
      sequence += 1;
      cursor = String(sequence);
      if (!result.ok) {
        return reply(parsed.envelope, null, { sequence, cursor, error: result.error });
      }
      return reply(parsed.envelope, result.value, { sequence, cursor });
    },

    events(): readonly BridgeEnvelope[] {
      return options.events?.() ?? buffered;
    },

    close(): Promise<void> {
      handshaken = false;
      return Promise.resolve();
    },
  };
}
