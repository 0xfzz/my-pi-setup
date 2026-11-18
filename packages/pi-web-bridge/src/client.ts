/** Pure client-side bridge slice: a plugin can only use names it declared. */
import { lookupMessage } from "./catalog.ts";
import type { BridgeEnvelope } from "./envelope.ts";
import { bridgeError, type BridgeError } from "./errors.ts";

export type BridgeResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

/** The built-in browser client keeps the full catalog; plugins are sliced. */
export const FIRST_PARTY_BRIDGE_CLIENT = "pi-web";

/** Supplied by the host client; the SDK never chooses a transport. */
export interface PluginBridgeTransport {
  invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResult<T>>;
  subscribe(
    name: string,
    listener: (envelope: BridgeEnvelope) => void,
    onError?: (source: unknown) => void,
  ): () => void;
}

export interface PluginBridgeOptions {
  readonly pluginId: string;
  readonly core: readonly string[];
  readonly transport: PluginBridgeTransport;
}

export interface PluginBridge {
  readonly pluginId: string;
  readonly core: readonly string[];
  invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResult<T>>;
  query<T>(name: string, params?: unknown, signal?: AbortSignal): Promise<BridgeResult<T>>;
  subscribe(
    name: string,
    listener: (envelope: BridgeEnvelope) => void,
    onError?: (source: unknown) => void,
  ): () => void;
}

/** The named denial shared by client refusal and host audit. */
export const BRIDGE_MESSAGE_DENIED = "BRIDGE_MESSAGE_DENIED" as const;

export function bridgeMessageDenied(pluginId: string, name: string): BridgeError {
  return bridgeError(BRIDGE_MESSAGE_DENIED, `plugin "${pluginId}" has not declared core message "${name}"`, {
    plugin: pluginId,
    message: name,
  });
}

/** Subscription cannot return a result; an exception carries the named code. */
export class BridgeMessageDeniedError extends Error {
  readonly code: BridgeError["code"];
  readonly bridgeError: BridgeError;

  constructor(error: BridgeError) {
    super(error.message);
    this.name = "BridgeMessageDeniedError";
    this.code = error.code;
    this.bridgeError = error;
  }
}

export function createPluginBridge(options: PluginBridgeOptions): PluginBridge {
  const declared = new Set(options.core.filter((name) => lookupMessage(name) !== undefined));
  const denial = (name: string): BridgeError => bridgeMessageDenied(options.pluginId, name);

  function requireDeclared(name: string): BridgeError | undefined {
    return declared.has(name) ? undefined : denial(name);
  }

  return {
    pluginId: options.pluginId,
    core: [...declared],

    async invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResult<T>> {
      const denied = requireDeclared(name);
      if (denied !== undefined) return { ok: false, error: denied };
      return options.transport.invoke<T>(name, payload, signal);
    },

    query<T>(name: string, params: unknown = {}, signal?: AbortSignal): Promise<BridgeResult<T>> {
      const denied = requireDeclared(name);
      if (denied !== undefined) return Promise.resolve({ ok: false, error: denied });
      if (lookupMessage(name)?.kind !== "query") {
        return Promise.resolve({
          ok: false,
          error: bridgeError("UNKNOWN_MESSAGE", `${name} is not a query`),
        });
      }
      return options.transport.invoke<T>(name, params, signal);
    },

    subscribe(name, listener, onError) {
      const denied = requireDeclared(name);
      if (denied !== undefined) throw new BridgeMessageDeniedError(denied);
      if (lookupMessage(name)?.kind !== "event") throw new Error(`${name} is not an event`);
      return options.transport.subscribe(name, listener, onError);
    },
  };
}
