/**
 * The browser's one protocol client. Every pi capability the UI uses crosses
 * here; the HTTP+SSE binding (route paths and SSE event names) lives in this
 * file, never in message schemas or components.
 */
import { Value } from "typebox/value";

import {
  createPluginBridge,
  FIRST_PARTY_BRIDGE_CLIENT,
  type BridgeResult,
  type PluginBridge,
  type PluginBridgeTransport,
  type PluginMessageKind,
} from "../protocol/index.ts";
import { MESSAGE_CATALOG, lookupMessage } from "../protocol/catalog.ts";
import { csrfHeaders } from "../shared/csrf.ts";
import { parseEnvelope, type BridgeEnvelope } from "../protocol/envelope.ts";
import { BRIDGE_ERROR_CODES, bridgeError, type BridgeError, type BridgeErrorCode } from "../protocol/errors.ts";
import { BRIDGE_PROTOCOL, BRIDGE_PROTOCOL_VERSION, HELLO, HelloAckSchema, HelloSchema, type HelloAck } from "../protocol/version.ts";
import type { PiApiName, PiApiParams, PiApiResult } from "../shared/pi-api.ts";

export type ProtocolResult<T> = { ok: true; value: T } | { ok: false; error: BridgeError };

export interface ProtocolClientOptions {
  readonly sessionId: string;
  readonly clientId?: string;
  readonly fetch?: typeof fetch;
  readonly eventSource?: typeof EventSource;
  readonly protocolPath?: (sessionId: string) => string;
}

type EventListener = (envelope: BridgeEnvelope) => void;

interface StreamListener {
  readonly listener: EventListener;
  readonly onError?: (source: EventSource) => void;
}

interface EventStream {
  readonly name: string;
  source: EventSource;
  readonly listeners: Set<StreamListener>;
}

const SESSION_EVENTS = "session.events";
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
  sourceId: string = clientId,
  kindOverride?: string,
): BridgeEnvelope {
  const coreKind = lookupMessage(name)?.kind;
  const kind = kindOverride === "event" || kindOverride === "command"
    || kindOverride === "query" || kindOverride === "capability" ? kindOverride : coreKind;
  if (kind === undefined) throw new Error(`unknown protocol message "${name}"`);
  return {
    protocol: BRIDGE_PROTOCOL,
    version: BRIDGE_PROTOCOL_VERSION,
    kind,
    name: name as BridgeEnvelope["name"],
    messageId: `${clientId}-${sequence}`,
    // Directory messages are session-less; a sentinel id would be a lie on the wire.
    ...(sessionId === "" ? {} : { sessionId }),
    source: { type: "browser", id: sourceId },
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
  private sessionId: string;
  private readonly clientId: string;
  private readonly post: typeof fetch;
  private readonly eventSource: typeof EventSource;
  private readonly protocolPath: (sessionId: string) => string;
  private readonly streams = new Map<string, EventStream>();
  private readonly customMessageKinds = new Map<string, PluginMessageKind>();
  private readonly bridgedListeners = new Map<string, Set<EventListener>>();
  private readonly pendingSessionListeners = new Set<StreamListener>();
  private ready: Promise<void> | undefined;

  constructor(options: ProtocolClientOptions) {
    this.sessionId = options.sessionId;
    this.clientId = options.clientId ?? FIRST_PARTY_BRIDGE_CLIENT;
    this.post = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.eventSource = options.eventSource ?? globalThis.EventSource;
    this.protocolPath = options.protocolPath ?? PROTOCOL_PATH;
  }

  /** Declared plugin names are client-side policy; the host still enforces them. */
  registerCustomMessages(declarations: readonly { name: string; kind: PluginMessageKind }[]): () => void {
    const added: Array<{ name: string; kind: PluginMessageKind }> = [];
    for (const declaration of declarations) {
      if (this.customMessageKinds.has(declaration.name)) continue;
      this.customMessageKinds.set(declaration.name, declaration.kind);
      added.push(declaration);
    }
    return () => {
      for (const declaration of added) {
        if (this.customMessageKinds.get(declaration.name) === declaration.kind) {
          this.customMessageKinds.delete(declaration.name);
        }
      }
    };
  }

  private customNames(): readonly string[] {
    return [...this.customMessageKinds.keys()];
  }

  /** A failed handshake must never be cached: auth refresh can repair it. */
  private handshake(): Promise<void> {
    this.ready ??= this.openHandshake().catch((error: unknown) => {
      this.ready = undefined;
      throw error;
    });
    return this.ready;
  }

  /**
   * Repoint every session-scoped stream and handshake at a new selection.
   * Plugin halves share this client, so they follow the browser without
   * reopening a private stream against a sentinel session id.
   */
  setSessionId(sessionId: string): void {
    if (this.sessionId === sessionId) return;
    this.sessionId = sessionId;
    this.ready = undefined;
    const pending = new Set(this.pendingSessionListeners);
    this.pendingSessionListeners.clear();
    const existing = this.streams.get(SESSION_EVENTS);
    if (existing !== undefined) existing.source.close();
    const listeners = new Set<StreamListener>([...pending, ...(existing?.listeners ?? [])]);
    this.streams.delete(SESSION_EVENTS);
    if (listeners.size === 0) return;
    if (sessionId === "") {
      for (const entry of listeners) this.pendingSessionListeners.add(entry);
      return;
    }
    const stream: EventStream = { name: SESSION_EVENTS, source: this.openSource(SESSION_EVENTS), listeners };
    this.streams.set(SESSION_EVENTS, stream);
    this.wireSource(stream);
  }

  /** Session-less streams live for the page; only the session stream moves. */
  private closeSessionStream(): void {
    const stream = this.streams.get(SESSION_EVENTS);
    if (stream === undefined) return;
    stream.source.close();
    for (const entry of stream.listeners) this.pendingSessionListeners.add(entry);
    this.streams.delete(SESSION_EVENTS);
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
    // HELLO is the one reply whose value is the raw ack, not an envelope.
    const outcome = await this.send<HelloAck>(envelopeFor(
      HELLO,
      hello,
      this.sessionId,
      this.clientId,
      0,
    ), undefined, true);
    if (!outcome.ok) throw outcome.error;
    if (outcome.value.version !== BRIDGE_PROTOCOL_VERSION) {
      throw bridgeError("VERSION_MISMATCH", `peer speaks protocol v${outcome.value.version}`);
    }
    if (!Value.Check(HelloAckSchema, outcome.value)) {
      throw bridgeError("VALIDATION_FAILED", "the server hello-ack does not match the protocol schema");
    }
  }

  private async send<T>(request: BridgeEnvelope, signal?: AbortSignal, rawAck = false): Promise<ProtocolResult<T>> {
    let response: Response;
    try {
      response = await this.post(this.protocolPath(this.sessionId), {
        method: "POST",
        headers: { ...csrfHeaders(), "Content-Type": "application/json" },
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
    return { ok: true, value: (rawAck ? body.value : body.value.payload) as T };
  }

  /** Send one typed envelope; commands and queries share the same transport. */
  async invoke<T>(name: string, payload: unknown, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    return this.invokeAs<T>({ name, payload, signal, sourceId: this.clientId });
  }

  /** A plugin half keeps the shared session stream but labels its own envelopes. */
  private async invokeAs<T>(request: {
    readonly name: string;
    readonly payload: unknown;
    readonly signal?: AbortSignal;
    readonly sourceId: string;
  }): Promise<ProtocolResult<T>> {
    const { name, payload, signal, sourceId } = request;
    const kind = this.customMessageKinds.get(name);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.handshake();
        break;
      } catch (error) {
        const bridgeError = asBridgeError(error);
        if (attempt === 1 || !bridgeError.retryable) return { ok: false, error: bridgeError };
      }
    }
    return this.send<T>(envelopeFor(name, payload, this.sessionId, this.clientId, ++this.sequence, sourceId, kind), signal);
  }

  /** SDK plugins receive this adapter instead of the full internal client. */
  pluginTransport(sourceId: string): PluginBridgeTransport {
    return {
      invoke: <T>(name: string, payload: unknown, signal?: AbortSignal): Promise<BridgeResult<T>> =>
        this.invokeAs<T>({ name, payload, signal, sourceId }),
      subscribe: (name, listener, onError) => this.subscribe(
        name,
        listener,
        onError === undefined ? undefined : (source) => onError(source),
      ),
    };
  }

  /** Read-only alias that makes UI call sites state their intent. */
  query<T>(name: string, params: unknown = {}, signal?: AbortSignal): Promise<ProtocolResult<T>> {
    const kind = lookupMessage(name)?.kind ?? this.customMessageKinds.get(name);
    if (kind !== "query") {
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

  private openSource(name: string): EventSource {
    return new this.eventSource(this.eventPath(name));
  }

  /**
   * Plugin-originated envelopes ride inside the session stream, so one
   * browser page needs one SSE connection no matter how many names it watches.
   */
  private dispatchBridged(envelope: BridgeEnvelope): void {
    const payload = envelope.payload;
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return;
    const wrapper = payload as { type?: unknown; envelope?: unknown };
    if (wrapper.type !== "protocol_envelope") return;
    const parsed = parseEnvelope(wrapper.envelope, this.customNames());
    if (!parsed.ok || parsed.envelope.kind !== "event") return;
    for (const listener of this.bridgedListeners.get(parsed.envelope.name) ?? []) listener(parsed.envelope);
  }

  private wireSource(stream: EventStream): void {
    stream.source.onmessage = (event) => {
      let frame: unknown;
      try {
        frame = JSON.parse(event.data);
      } catch {
        return;
      }
      const parsed = parseEnvelope(frame, this.customNames());
      if (!parsed.ok || parsed.envelope.kind !== "event" || parsed.envelope.name !== stream.name) return;
      for (const entry of stream.listeners) entry.listener(parsed.envelope);
      if (stream.name === SESSION_EVENTS) {
        this.dispatchBridged(parsed.envelope);
        const payload = parsed.envelope.payload as { type?: unknown } | null;
        // A missing or replaced session is terminal for every stream that
        // belongs to it; EventSource would otherwise reconnect forever.
        if (payload?.type === "startup_error") this.closeSessionStream();
      }
    };
    stream.source.onerror = () => {
      for (const entry of stream.listeners) entry.onError?.(stream.source);
    };
  }

  private openStream(name: string): EventStream {
    const stream: EventStream = { name, source: this.openSource(name), listeners: new Set() };
    this.wireSource(stream);
    return stream;
  }

  /** Subscribe to a catalog event; subscribers of one channel share the stream. */
  subscribe(
    name: string,
    listener: EventListener,
    onError?: (source: EventSource) => void,
  ): () => void {
    const kind = lookupMessage(name)?.kind ?? this.customMessageKinds.get(name);
    if (kind !== "event") throw new Error(`${name} is not an event`);
    if (name !== SESSION_EVENTS && name !== DIRECTORY_EVENTS) {
      let listeners = this.bridgedListeners.get(name);
      if (listeners === undefined) {
        listeners = new Set();
        this.bridgedListeners.set(name, listeners);
      }
      listeners.add(listener);
      // The session stream is opened on first use, not once per plugin name.
      const leaveSession = this.subscribe(SESSION_EVENTS, () => undefined);
      return () => {
        const current = this.bridgedListeners.get(name);
        current?.delete(listener);
        if (current?.size === 0) this.bridgedListeners.delete(name);
        leaveSession();
      };
    }
    const entry: StreamListener = { listener, onError };
    if (name === SESSION_EVENTS && this.sessionId === "") {
      this.pendingSessionListeners.add(entry);
      return () => this.pendingSessionListeners.delete(entry);
    }
    let stream = this.streams.get(name);
    if (stream === undefined) {
      stream = this.openStream(name);
      this.streams.set(name, stream);
    }
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

/** Plugin halves share one client that follows the selected session. */
export const pluginProtocolClient = new ProtocolClient({ sessionId: "" });

export interface CorePluginBridgeOptions {
  readonly pluginId: string;
  readonly core: readonly string[];
  readonly client?: ProtocolClient;
  readonly custom?: readonly { name: string; kind: PluginMessageKind }[];
}

export interface CorePluginBridge extends PluginBridge {
  /** Removes names that became stale after plugins_changed. */
  dispose(): void;
}

/** The core-side factory: SDK policy over the existing browser transport. */
export function createCorePluginBridge(options: CorePluginBridgeOptions): CorePluginBridge {
  const client = options.client ?? pluginProtocolClient;
  const release = client.registerCustomMessages(options.custom ?? []);
  const bridge = createPluginBridge({
    pluginId: options.pluginId,
    core: options.core,
    transport: client.pluginTransport(options.pluginId),
  });
  return { ...bridge, dispose: release };
}

export function setPluginSession(sessionId: string | null): void {
  pluginProtocolClient.setSessionId(sessionId ?? "");
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
