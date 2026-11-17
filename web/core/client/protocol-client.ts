/**
 * The browser's one protocol client. Every pi capability the UI uses crosses
 * here; the HTTP+SSE binding (route paths and SSE event names) lives in this
 * file, never in message schemas or components.
 */
import { MESSAGE_CATALOG, lookupMessage } from "../protocol/catalog.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO } from "../protocol/version.ts";
import type { BridgeEnvelope } from "../protocol/envelope.ts";
import type { BridgeError } from "../protocol/errors.ts";
import type { PiApiName, PiApiParams, PiApiResult } from "../shared/pi-api.ts";

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface ProtocolClientOptions {
  readonly sessionId: string;
  readonly clientId?: string;
  readonly fetch?: typeof fetch;
  readonly protocolPath?: (sessionId: string) => string;
}

const PROTOCOL_PATH = (sessionId: string): string =>
  `/api/agent/${encodeURIComponent(sessionId)}/protocol`;

/** One envelope factory for every call, including correlation and source id. */
function envelopeFor(
  name: string,
  payload: unknown,
  sessionId: string,
  clientId: string,
  sequence: number,
): BridgeEnvelope {
  const message = lookupMessage(name);
  if (message === undefined) throw new Error(`unknown protocol message "${name}"`);
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind: message.kind,
    name: name as BridgeEnvelope["name"],
    messageId: `${clientId}-${sequence}`,
    sessionId,
    source: { type: "browser", id: clientId },
    timestamp: 0,
    payload,
  };
}

function transportFailure(error: unknown): BridgeError {
  return {
    code: "UNSUPPORTED_BINDING",
    message: error instanceof Error ? error.message : "the protocol route did not answer",
    retryable: true,
  };
}

export class ProtocolClient {
  private sequence = 0;
  private readonly sessionId: string;
  private readonly clientId: string;
  private readonly post: typeof fetch;
  private readonly protocolPath: (sessionId: string) => string;
  private ready: Promise<void> | undefined;

  constructor(options: ProtocolClientOptions) {
    this.sessionId = options.sessionId;
    this.clientId = options.clientId ?? "pi-web";
    this.post = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.protocolPath = options.protocolPath ?? PROTOCOL_PATH;
  }

  /** The capability handshake runs once, before any command or query. */
  private handshake(): Promise<void> {
    this.ready ??= this.send<{ version: number }>(envelopeFor(
      HELLO,
      { version: BRIDGE_PROTOCOL_VERSION, bindings: ["http-sse"], clientId: this.clientId, capabilities: [] },
      this.sessionId,
      this.clientId,
      0,
    )).then((outcome) => {
      if (!outcome.ok) throw new Error(outcome.error.message);
      if (outcome.value.version !== BRIDGE_PROTOCOL_VERSION) {
        throw new Error(`protocol version mismatch: ${outcome.value.version}`);
      }
    });
    return this.ready;
  }

  private async send<T>(request: BridgeEnvelope, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    let response: Response;
    try {
      response = await this.post(this.protocolPath(this.sessionId), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        ...(signal === undefined ? {} : { signal }),
      });
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }
    const body = await response.json().catch(() => null) as {
      ok?: boolean;
      value?: BridgeEnvelope;
      error?: BridgeError;
    } | null;
    if (body?.ok !== true || body.value === undefined) {
      return { ok: false, error: body?.error ?? transportFailure("invalid protocol reply") };
    }
    if (body.value.error !== undefined) return { ok: false, error: body.value.error };
    return { ok: true, value: body.value.payload as T };
  }

  /** Send one typed envelope; commands and queries share the same transport. */
  async invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    try {
      await this.handshake();
    } catch (error) {
      return { ok: false, error: transportFailure(error) };
    }
    return this.send<T>(envelopeFor(name, payload, this.sessionId, this.clientId, ++this.sequence), signal);
  }

  /** Read-only alias that makes UI call sites state their intent. */
  query<T>(name: string, params: unknown = {}, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    const message = lookupMessage(name);
    if (message?.kind !== "query") {
      return Promise.resolve({
        ok: false,
        error: { code: "UNKNOWN_MESSAGE", message: `${name} is not a query`, retryable: false },
      });
    }
    return this.invoke<T>(name, params, signal);
  }

  /** The 15 pi built-in APIs, typed by their existing wire contract. */
  piApi<K extends PiApiName>(api: K, params: PiApiParams[K], signal?: AbortSignal): Promise<ProtocolResult<PiApiResult[K]>> {
    return this.invoke<PiApiResult[K]>(api, params, signal);
  }

  /** Subscribe to a catalog event name; the binding maps it to the SSE stream. */
  subscribe(name: string, listener: (envelope: BridgeEnvelope) => void): () => void {
    const message = lookupMessage(name);
    if (message?.kind !== "event") throw new Error(`${name} is not an event`);
    const source = new EventSource(this.protocolPath(this.sessionId).replace("/protocol", "/events"));
    source.onmessage = (event) => {
      try {
        const raw = JSON.parse(event.data) as { type?: string; event?: { type?: string }; payload?: unknown };
        if (raw.type === "web_ui_event" && raw.event?.type === name) {
          listener({
            ...envelopeFor(name, raw.payload ?? {}, this.sessionId, this.clientId, ++this.sequence),
            kind: "event",
            sequence: this.sequence,
          });
        }
      } catch {
        // A malformed stream frame is dropped; the next resync converges.
      }
    };
    return () => source.close();
  }

  /** Rebuild UI state from the same stores the live events update. */
  snapshot<T>(): Promise<ProtocolResult<T>> {
    return this.query<T>("ui.snapshot");
  }
}

/** One client per session; components share it instead of opening routes. */
const clients = new Map<string, ProtocolClient>();

export function protocolClient(sessionId: string): ProtocolClient {
  let client = clients.get(sessionId);
  if (client === undefined) {
    client = new ProtocolClient({ sessionId });
    clients.set(sessionId, client);
  }
  return client;
}

export const PROTOCOL_MESSAGE_COUNT = MESSAGE_CATALOG.length;

/**
 * Compatibility helper for the old pi_api wire shape. The route is retired;
 * wire shape is preserved so components need no parallel error vocabulary;
 * new code should call `client.piApi()` directly.
 */
export function piApiFetch<K extends PiApiName>(
  sessionId: string,
  api: K,
  params: PiApiParams[K],
): Promise<{ ok: boolean; json(): Promise<unknown> }> {
  return protocolClient(sessionId).piApi(api, params).then((outcome) => ({
    ok: outcome.ok,
    json: async () => outcome.ok
      ? { ok: true, result: outcome.value }
      : { ok: false, error: outcome.error.message },
  }));
}
