/** Byte budgets include both the formatter's pending frames and the socket. */
export interface SsePressureLimits {
  dropAboveBytes: number;
  closeAboveBytes: number;
}

export const MAIN_SSE_LIMITS: Readonly<SsePressureLimits> = {
  dropAboveBytes: 512 * 1024,
  closeAboveBytes: 16 * 1024 * 1024,
};

export function sseAdmission(input: {
  bufferedBytes: number;
  frameBytes: number;
  droppable: boolean;
  limits: SsePressureLimits;
}): "send" | "drop" | "close" {
  if (input.bufferedBytes + input.frameBytes > input.limits.closeAboveBytes) return "close";
  if (input.droppable && input.bufferedBytes > input.limits.dropAboveBytes) return "drop";
  return "send";
}

// JSON encodes embedded newlines, so data/retry field overhead is fixed.
export function encodedSseBytes(encoded: string, retry?: number): number {
  const dataFieldOverhead = 8;
  const retryFieldOverhead = 8;
  return Buffer.byteLength(encoded) + dataFieldOverhead
    + (retry ? String(retry).length + retryFieldOverhead : 0);
}

/** Producer-side ordering/coalescing buffer; capacity is shared with the wire. */
export class BoundedSseEvents {
  readonly #events = new Map<unknown, { encoded: string; bytes: number }>();
  #bytes = 0;

  get bytes(): number { return this.#bytes; }

  put(key: unknown, event: unknown, availableBytes: number): boolean {
    let encoded: string | undefined;
    try { encoded = JSON.stringify(event); } catch { return false; }
    if (encoded === undefined) return false;
    const bytes = encodedSseBytes(encoded);
    const nextBytes = this.#bytes - (this.#events.get(key)?.bytes ?? 0) + bytes;
    if (nextBytes > availableBytes) return false;
    // Do not retain a mutable event whose payload can grow after admission.
    this.#events.set(key, { encoded, bytes });
    this.#bytes = nextBytes;
    return true;
  }

  delete(key: unknown): void {
    const entry = this.#events.get(key);
    if (!entry) return;
    this.#bytes -= entry.bytes;
    this.#events.delete(key);
  }

  clear(): void {
    this.#events.clear();
    this.#bytes = 0;
  }

  *consume(): IterableIterator<unknown> {
    for (const [key, entry] of this.#events) {
      this.delete(key);
      const event: unknown = JSON.parse(entry.encoded);
      yield event;
    }
  }
}
