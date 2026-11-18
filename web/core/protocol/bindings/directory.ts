/**
 * The directory binding: POST /api/protocol has no selected session, so its
 * envelopes carry no sessionId. It grants the same session-less messages the
 * old /api/sessions and /api/agent/new routes served, nothing more.
 */
import { createDirectoryAdapters, type DirectorySurface } from "../../adapters/directory.ts";
import type { ProtocolAdapter } from "../../adapters/types.ts";
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
import type { BindingOptions, BindingReply, ProtocolBinding } from "./types.ts";

export interface DirectoryOptions extends BindingOptions {
  readonly directory: DirectorySurface;
  /** Accepted for a uniform host factory; directory messages never select a client id. */
  readonly clientId?: string;
}

function adapterFor(name: string, surface: DirectorySurface): ProtocolAdapter | undefined {
  const adapters: Record<string, ProtocolAdapter> = createDirectoryAdapters(surface);
  return adapters[name];
}

export function createDirectoryBinding(options: DirectoryOptions): ProtocolBinding {
  let handshake: Handshake | undefined;
  let sequence = 0;
  let cursor = options.initialCursor ?? "0";
  const buffered: BridgeEnvelope[] = [];

  return {
    name: "http-sse",

    hello(hello: Hello): Promise<BindingReply<HelloAck>> {
      const result = handshakeFor(hello, options);
      if (result.ok) {
        handshake = result.value;
        const { version, capabilities, bindings, cursor: helloCursor } = result.value;
        return Promise.resolve({ ok: true, value: { version, capabilities, bindings, cursor: helloCursor } });
      }
      return Promise.resolve(result);
    },

    async invoke(envelope: BridgeEnvelope, signal: AbortSignal = new AbortController().signal): Promise<BindingReply> {
      if (handshake === undefined) return { ok: false, error: handshakeRequired() };
      const parsed = parseEnvelope(envelope);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      if (parsed.envelope.sessionId !== undefined) {
        return { ok: false, error: bridgeError("VALIDATION_FAILED", "directory messages must not select a session") };
      }
      if (parsed.envelope.version !== BRIDGE_PROTOCOL_VERSION) {
        return { ok: false, error: versionMismatch(parsed.envelope.version) };
      }
      const attributed = attributedSource(parsed.envelope, handshake, "http-sse");
      const message = messageFor(attributed);
      if (message === undefined) {
        return { ok: false, error: bridgeError("UNKNOWN_MESSAGE", `unknown protocol message "${attributed.name}"`) };
      }
      const denied = gate(message, attributed, handshake, options.audit);
      if (denied !== undefined) return { ok: false, error: denied };

      sequence += 1;
      cursor = String(sequence);
      if (message.kind === "event") buffered.push({ ...attributed, sequence, cursor });
      if (message.kind === "capability") return reply(attributed, { acknowledged: true }, { sequence, cursor });

      const adapter = adapterFor(attributed.name, options.directory);
      if (adapter === undefined) {
        return { ok: false, error: bridgeError("ADAPTER_UNAVAILABLE", `"${attributed.name}" requires a session route`) };
      }
      const result = await adapter(
        { cwd: options.cwd, grantedCapabilities: options.grantedCapabilities },
        attributed.payload,
        signal,
      );
      return reply(attributed, result.ok ? result.value : null, {
        sequence,
        cursor,
        ...(result.ok ? {} : { error: result.error }),
      });
    },

    events: () => buffered,
    close: () => {
      handshake = undefined;
      return Promise.resolve();
    },
  };
}
