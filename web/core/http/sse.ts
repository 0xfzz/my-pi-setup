// Shared HTTP mechanism only: no sessions, auth state or graph runtime imports.
// @fastify/sse owns framing/headers/close; its public formatter stream lets Node
// pipe backpressure apply without one pending send()/drain promise per event.
import { PassThrough, Transform } from "node:stream";
import type { FastifyReply } from "fastify";
import { encodedSseBytes, MAIN_SSE_LIMITS, sseAdmission, type SsePressureLimits } from "../../../lib/sse-pressure.ts";

export const SSE_ROUTE_OPTIONS = {
  kind: "manual" as const,
  heartbeat: false,
  // Immutable JSON strings make accounting exact even while a frame is queued.
  // Framing still belongs to the library, not to this policy adapter.
  serializer: (encoded: unknown): string => {
    if (typeof encoded !== "string") throw new TypeError("expected encoded SSE data");
    return encoded;
  },
};

interface SendOptions {
  droppable?: boolean;
  retry?: number;
  /** Producer prelude/coalescing buffers not yet handed to the formatter. */
  reservedBytes?: number;
}

export interface EventChannel {
  readonly closed: boolean;
  readonly bufferedBytes: number;
  send(data: unknown, options?: SendOptions): void;
  checkPressure(): void;
  onClose(callback: () => void): void;
  close(): void;
}

/** Live channels, so an orderly restart can give every stream a resume hint. */
const channels = new Set<EventChannel>();

/**
 * Send a final event to every open stream and end it. The retry field tells
 * EventSource to come back quickly once the replacement process listens.
 */
export function closeAllEventChannels(message: string): void {
  for (const channel of Array.from(channels)) {
    channel.send({ type: "code_changes", message }, { retry: 1_000 });
    channel.close();
  }
}

// Conservatively reserve HTTP chunk framing before a new frame reaches raw.
// Once written, raw.writableLength includes its actual chunk overhead.
const HTTP_CHUNK_RESERVE_BYTES = 16;

class BufferedEventChannel implements EventChannel {
  readonly #reply: FastifyReply;
  readonly #limits: SsePressureLimits;
  readonly #formatter: Transform;
  // The formatter emits object-mode strings. Convert to bytes before the socket:
  // Node's HTTP string queue can report UTF-16 lengths, undercounting Unicode.
  readonly #bytes = new PassThrough();
  #queuedBytes = 0;
  #ended = false;
  #closing = false;

  constructor(reply: FastifyReply, limits: SsePressureLimits) {
    this.#reply = reply;
    this.#limits = limits;
    const formatter = reply.sse.stream();
    if (!(formatter instanceof Transform)) throw new TypeError("unsupported SSE formatter stream");
    this.#formatter = formatter;
    this.#connect();
    reply.sse.keepAlive();
    reply.sse.sendHeaders();
    // sendHeaders writes the head but does not flush it without data. Startup
    // may be slow; do not invent a data event just to flush the socket.
    reply.raw.flushHeaders();
  }

  #connect(): void {
    this.#bytes.on("data", (chunk: Buffer) => { this.#queuedBytes -= chunk.length; });
    this.#formatter.on("error", () => this.#abort());
    this.#bytes.on("error", () => this.#abort());
    this.#bytes.on("end", () => this.#reply.sse.close());
    this.#reply.sse.onClose(() => this.#release());
    this.#formatter.pipe(this.#bytes).pipe(this.#reply.raw, { end: false });
  }

  #release(): void {
    this.#ended = true;
    this.#formatter.unpipe(this.#bytes);
    this.#bytes.unpipe(this.#reply.raw);
    this.#formatter.destroy();
    this.#bytes.destroy();
    this.#queuedBytes = 0;
  }

  #abort(): void {
    this.#reply.sse.close();
    // close() is graceful. Pressure overflow must also cut a stalled socket.
    this.#reply.raw.destroy();
  }

  get closed(): boolean { return this.#ended || this.#closing; }
  get bufferedBytes(): number { return this.#queuedBytes + this.#reply.raw.writableLength; }

  send(data: unknown, options?: SendOptions): void {
    if (this.closed) return;
    try {
      const encoded = JSON.stringify(data);
      if (encoded === undefined) throw new TypeError("SSE data is not JSON serializable");
      const retry = options?.retry;
      const frameBytes = encodedSseBytes(encoded, retry);
      const admission = this.#admission(frameBytes, options);
      if (admission === "close") return this.#abort();
      if (admission === "drop") return;
      this.#queuedBytes += frameBytes;
      this.#formatter.write({ data: encoded, ...(retry ? { retry } : {}) });
    } catch {
      this.#abort();
    }
  }

  #admission(frameBytes: number, options?: SendOptions): "send" | "drop" | "close" {
    return sseAdmission({
      bufferedBytes: this.bufferedBytes + (options?.reservedBytes ?? 0),
      frameBytes: frameBytes + HTTP_CHUNK_RESERVE_BYTES,
      droppable: options?.droppable ?? false,
      limits: this.#limits,
    });
  }

  checkPressure(): void {
    if (!this.#ended && this.bufferedBytes > this.#limits.closeAboveBytes) this.#abort();
  }

  onClose(callback: () => void): void {
    if (this.#ended) callback();
    else this.#reply.sse.onClose(callback);
  }

  close(): void {
    if (this.closed) return;
    this.#closing = true;
    // Drain admitted non-droppable frames before the plugin closes the wire.
    this.#formatter.end();
  }
}

export function openEventChannel(reply: FastifyReply, limits: SsePressureLimits = MAIN_SSE_LIMITS): EventChannel {
  const channel = new BufferedEventChannel(reply, limits);
  channels.add(channel);
  channel.onClose(() => channels.delete(channel));
  return channel;
}
