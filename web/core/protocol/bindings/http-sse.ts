/**
 * Production HTTP+SSE binding. The route owns framing and the SSE stream;
 * this module owns the binding's handshake, browser source attribution and
 * adapter dispatch for one browser client.
 */
import type { BridgeEnvelope } from "../envelope.ts";
import type { Hello, HelloAck } from "../version.ts";
import { createInProcessBinding, type InProcessOptions } from "./in-process.ts";
import type { BindingReply, ProtocolBinding } from "./types.ts";

export interface HttpSseOptions extends InProcessOptions {
  /** The host knows which browser opened the connection; the client does not. */
  readonly clientId?: string;
}

/** The browser transport never lets a caller label itself as trusted core/host. */
export function attributedEnvelope(envelope: BridgeEnvelope, clientId: string): BridgeEnvelope {
  const source = envelope.source;
  if (source.type !== "core" && source.type !== "host") return envelope;
  return { ...envelope, source: { type: "browser", id: clientId } };
}

export function createHttpSseBinding(options: HttpSseOptions): ProtocolBinding {
  const delegate = createInProcessBinding({
    ...options,
    name: "http-sse",
    bridgeSlices: options.bridgeSlices,
  });
  let clientId = options.clientId ?? "";

  return {
    name: "http-sse",

    hello(hello: Hello): Promise<BindingReply<HelloAck>> {
      const result = delegate.hello(hello);
      return result.then((outcome) => {
        if (outcome.ok) clientId = hello.clientId;
        return outcome;
      });
    },

    invoke(envelope: BridgeEnvelope, signal?: AbortSignal): Promise<BindingReply> {
      return delegate.invoke(attributedEnvelope(envelope, clientId), signal);
    },

    invokeValidated(envelope: BridgeEnvelope, signal?: AbortSignal): Promise<BindingReply> {
      return delegate.invokeValidated(attributedEnvelope(envelope, clientId), signal);
    },

    events: () => delegate.events(),
    close: () => delegate.close(),
  };
}
