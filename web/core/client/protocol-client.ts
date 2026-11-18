/**
 * The browser's one protocol client. Every pi capability the UI uses crosses
 * here; the HTTP+SSE binding (route paths and SSE event names) lives in this
 * file, never in message schemas or components.
 */
import { Value } from "typebox/value";

import { MESSAGE_CATALOG, lookupMessage } from "../protocol/catalog.ts";
import { parseEnvelope, type BridgeEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_ERROR_CODES, bridgeError, type BridgeError, type BridgeErrorCode } from "../protocol/errors.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO, HelloAckSchema, HelloSchema } from "../protocol/version.ts";
import type { PiApiName, PiApiParams, PiApiResult } from "../shared/pi-api.ts";

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface ProtocolClientOptions {
  readonly sessionId: string;
  readonly clientId?: string;
  readonly fetch?: typeof fetch;
  readonly eventSource?: typeof EventSource;
  readonly protocolPath?: (sessionId: string) => string;
}

interface EventStream {
  readonly source: EventSource;
  readonly listeners: Set<{
    listener: (envelope: BridgeEnvelope) => void;
    onError?: (source: EventSource) => void;
  }>;
}

const DIRECTORY_EVENTS = "session.directory.events";
const DIRECTORY_EVENTS_PATH = "/api/sessions/events";

const PROTOCOL_PATH = (sessionId: string): string =>
  `/api/agent/${encodeURIComponent(sessionId)}/protocol`;
const DIRECTORY_PROTOCOL_PATH = (): string => "/api/protocol";

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
    // Directory messages are session-less; a sentinel id would be a lie on the wire.
    ...(sessionId === "" ? {} : { sessionId }),
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

/** A binding reply may carry a named BridgeError; only its declared fields cross. */
function namedError(value: unknown): BridgeError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Partial<BridgeError>;
  if (!BRIDGE_ERROR_CODES.includes(candidate.code as BridgeErrorCode) || typeof candidate.message !== "string") {
    return undefined;
  }
  return {
    code: candidate.code as BridgeErrorCode,
    message: candidate.message,
    retryable: candidate.retryable === true,
    ...(candidate.details === undefined ? {} : { details: candidate.details }),
  };
}

function asBridgeError(error: unknown): BridgeError {
  return namedError(error) ?? transportFailure(error);
}

export class ProtocolClient {
  private sequence = 0;
  private readonly sessionId: string;
  private readonly clientId: string;
  private readonly post: typeof fetch;
  private readonly eventSource: typeof EventSource;
  private readonly protocolPath: (sessionId: string) => string;
  private readonly streams = new Map<string, EventStream>();
  private ready: Promise<void> | undefined;

  constructor(options: ProtocolClientOptions) {
    this.sessionId = options.sessionId;
    this.clientId = options.clientId ?? "pi-web";
    this.post = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.eventSource = options.eventSource ?? globalThis.EventSource;
    this.protocolPath = options.protocolPath ?? PROTOCOL_PATH;
  }

  /** The capability handshake runs once, before any command or query. */
  private handshake(): Promise<void> {
    this.ready ??= this.openHandshake();
    return this.ready;
  }

  private async openHandshake(): Promise<void> {
    const hello = {
      version: BRIDGE_PROTOCOL_VERSION,
      bindings: ["http-sse"],
      clientId: this.clientId,
      capabilities: [],
    };
    if (!Value.Check(HelloSchema, hello)) {
      throw bridgeError("VALIDATION_FAILED", "the client hello does not match the protocol schema");
    }
    const outcome = await this.send<{ version: number }>(envelopeFor(
      HELLO,
      hello,
      this.sessionId,
      this.clientId,
      0,
    ));
    if (!outcome.ok) throw outcome.error;
    if (outcome.value.version !== BRIDGE_PROTOCOL_VERSION) {
      throw bridgeError("VERSION_MISMATCH", `peer speaks protocol v${outcome.value.version}`);
    }
    if (!Value.Check(HelloAckSchema, outcome.value)) {
      throw bridgeError("VALIDATION_FAILED", "the server hello-ack does not match the protocol schema");
    }
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
      return { ok: false, error: namedError(body?.error) ?? transportFailure("invalid protocol reply") };
    }
    if (body.value.error !== undefined) {
      return { ok: false, error: namedError(body.value.error) ?? transportFailure("invalid protocol error") };
    }
    return { ok: true, value: body.value.payload as T };
  }

  /** Send one typed envelope; commands and queries share the same transport. */
  async invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    try {
      await this.handshake();
    } catch (error) {
      return { ok: false, error: asBridgeError(error) };
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

  private eventPath(name: string): string {
    if (name === DIRECTORY_EVENTS) return DIRECTORY_EVENTS_PATH;
    return this.protocolPath(this.sessionId).replace(/\/protocol$/, "/events");
  }

  private openStream(name: string): EventStream {
    const source = new this.eventSource(this.eventPath(name));
    const stream: EventStream = { source, listeners: new Set() };
    source.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = parseEnvelope(frame);
      if (!parsed.ok || parsed.envelope.kind !== "event" || parsed.envelope.name !== name) return;
      for (const entry of stream.listeners) entry.listener(parsed.envelope);
    };
    source.onerror = () => {
      for (const entry of stream.listeners) entry.onError?.(source);
    };
    return stream;
  }

  /** Subscribe to a catalog event; subscribers of one channel share the stream. */
  subscribe(
    name: string,
    listener: (envelope: BridgeEnvelope) => void,
    onError?: (source: EventSource) => void,
  ): () => void {
    const message = lookupMessage(name);
    if (message?.kind !== "event") throw new Error(`${name} is not an event`);
    let stream = this.streams.get(name);
    if (stream === undefined) {
      stream = this.openStream(name);
      this.streams.set(name, stream);
    }
    const entry = { listener, onError };
    stream.listeners.add(entry);
    return () => {
      const current = this.streams.get(name);
      if (current === undefined) return;
      current.listeners.delete(entry);
      if (current.listeners.size !== 0) return;
      current.source.close();
      this.streams.delete(name);
    };
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

/** Session-less directory calls use their own binding; no session is implied. */
let directoryClient: ProtocolClient | undefined;

export function directoryProtocolClient(): ProtocolClient {
  directoryClient ??= new ProtocolClient({
    sessionId: "",
    protocolPath: DIRECTORY_PROTOCOL_PATH,
  });
  return directoryClient;
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
