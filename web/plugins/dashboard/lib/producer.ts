/**
 * producer.ts — the Pi-side client for the shared dashboard server.
 *
 * A producer is a *coalescing* publisher: `publish()` never awaits, never blocks
 * the parent session, and never queues snapshots. It stores the latest snapshot
 * and schedules one flush; while a flush is in flight, further publishes only
 * replace the pending snapshot. A slow or dead server therefore costs the
 * parent nothing beyond replacing an object reference — dashboard failure
 * cannot stall orchestration.
 *
 * ── Ordering and replacement ───────────────────────────────────────────────
 * The client keeps one revision counter and only increments it when the server
 * acknowledges. That makes an out-of-order or duplicated packet harmless; the
 * server refuses a lower revision with 409 and the client adopts the server's
 * revision instead of fighting it. A producer instance id plus a server-assigned
 * generation identifies the lease: if another producer registers the same
 * session, this one receives 410 and stops publishing permanently rather than
 * flip-flopping ownership (and the server tombstones this id, so a delayed
 * packet cannot take the session back).
 *
 * ── Reconnection ───────────────────────────────────────────────────────────
 * A network failure drops the cached address, so the next attempt re-runs
 * `ensureDashboard()` — which reuses a healthy server or starts a new one after
 * the old process died. A restarted server answers 404 `unregistered`; the client
 * resets its generation and republishes the full snapshot. Heartbeats keep the
 * lease alive between publishes without resending an 8 MiB snapshot, and let the
 * server distinguish "no updates" from "producer gone".
 */
import { randomUUID } from "node:crypto";

import type { DashboardAddress, EnsureDashboardOptions } from "./lifecycle.ts";
import { ensureDashboard } from "./lifecycle.ts";
import type { DashboardSnapshot } from "./protocol.ts";
import { sanitizeSnapshot } from "./validation.ts";

/** Internal seams; the documented contract is the four public options. */
export interface DashboardProducerOptions {
  onReady?: (url: string) => void;
  onError?: (error: unknown) => void;
  runtimeDir?: string;
  /** Lease keep-alive interval. Defaults to 15s. `0` disables heartbeats. */
  heartbeatMs?: number;
  /** Test seam: replace the lifecycle entry point. */
  ensure?: (options: EnsureDashboardOptions) => Promise<DashboardAddress>;
  /** Test seam: replace fetch. */
  fetchImpl?: typeof fetch;
  now?: () => number;
  requestTimeoutMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
}

type TransmitResult = "sent" | "retry" | "drop" | "resend";

const DEFAULT_HEARTBEAT_MS = 15_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 4_000;
const DEFAULT_RETRY_BASE_MS = 250;
const DEFAULT_RETRY_MAX_MS = 10_000;
const CLOSE_TIMEOUT_MS = 2_000;
const PRODUCER_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

export class DashboardProducer {
  readonly #onReady: ((url: string) => void) | undefined;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #ensure: (options: EnsureDashboardOptions) => Promise<DashboardAddress>;
  readonly #fetch: typeof fetch;
  readonly #now: () => number;
  readonly #heartbeatMs: number;
  readonly #requestTimeoutMs: number;
  readonly #retryBaseMs: number;
  readonly #retryMaxMs: number;
  readonly #runtimeDir: string | undefined;

  readonly #producerId: string;
  #sessionId = "";
  #generation = 0;
  #revision = 0;
  #latest: DashboardSnapshot | null = null;
  #pending = false;
  #address: DashboardAddress | null = null;
  #startPromise: Promise<DashboardAddress> | null = null;
  #flushing = false;
  #flushPromise: Promise<void> | null = null;
  #flushTimer: NodeJS.Timeout | null = null;
  #heartbeatTimer: NodeJS.Timeout | null = null;
  #retryDelayMs: number;
  #lastAckAt = 0;
  #lastErrorKey = "";
  #lastNotifiedUrl: string | null = null;
  #resendStreak = 0;
  #superseded = false;
  #closed = false;
  #closedResolve: (() => void) | null = null;
  #closedPromise = new Promise<void>(resolveClose => {
    this.#closedResolve = resolveClose;
  });

  constructor(options: DashboardProducerOptions = {}) {
    this.#onReady = options.onReady;
    this.#onError = options.onError;
    this.#ensure = options.ensure ?? ensureDashboard;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#now = options.now ?? Date.now;
    this.#heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.#retryBaseMs = options.retryBaseMs ?? DEFAULT_RETRY_BASE_MS;
    this.#retryMaxMs = options.retryMaxMs ?? DEFAULT_RETRY_MAX_MS;
    this.#runtimeDir = options.runtimeDir;
    this.#retryDelayMs = this.#retryBaseMs;
    let id: string = randomUUID();
    if (!PRODUCER_ID_PATTERN.test(id)) id = id.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
    this.#producerId = id;
  }

  /** The bootstrap URL reported via `onReady`, once known. */
  get url(): string | null {
    return this.#address?.browserUrl ?? null;
  }

  get sessionId(): string {
    return this.#sessionId;
  }

  /** True once the server has told this producer it was replaced. */
  get superseded(): boolean {
    return this.#superseded;
  }

  /** Resolves when `close()` finished. */
  get closed(): Promise<void> {
    return this.#closedPromise;
  }

  /**
   * Publish the latest snapshot. Synchronous and non-throwing: validation
   * failures and transport failures are reported through `onError` and never
   * propagate into the parent.
   */
  publish(snapshot: DashboardSnapshot): void {
    if (this.#closed || this.#superseded) return;
    let clean: DashboardSnapshot;
    try {
      clean = sanitizeSnapshot(snapshot);
    } catch (error) {
      this.#report(error);
      return;
    }
    if (clean.session.id !== this.#sessionId) {
      // A different session on the same producer object is a fresh lease.
      this.#sessionId = clean.session.id;
      this.#generation = 0;
      this.#revision = 0;
    }
    this.#latest = clean;
    this.#pending = true;
    this.#scheduleFlush(0);
    this.#startHeartbeat();
  }

  /** Stop publishing, best-effort unregister, and release timers. Never throws. */
  async close(): Promise<void> {
    if (this.#closed) return this.#closedPromise;
    this.#closed = true;
    this.#stopTimers();

    const pendingWork: Promise<unknown>[] = [];
    if (this.#startPromise !== null) pendingWork.push(this.#startPromise);
    if (this.#flushPromise !== null) pendingWork.push(this.#flushPromise);
    if (pendingWork.length > 0) {
      await Promise.race([
        Promise.allSettled(pendingWork),
        new Promise<void>(resolveRace => {
          const timer = setTimeout(resolveRace, CLOSE_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
    }
    if (this.#address !== null && this.#sessionId !== "") {
      await this.#unregister().catch(() => {});
    }
    this.#address = null;
    this.#latest = null;
    this.#pending = false;
    this.#closedResolve?.();
    return this.#closedPromise;
  }

  // ── Flush machinery ──────────────────────────────────────────────────────

  #scheduleFlush(delayMs: number): void {
    if (this.#closed || this.#superseded) return;
    if (this.#flushTimer !== null) return;
    const timer = setTimeout(() => {
      this.#flushTimer = null;
      void this.#flushLoop();
    }, delayMs);
    this.#flushTimer = timer;
  }

  async #flushLoop(): Promise<void> {
    if (this.#flushing || this.#closed || this.#superseded) return;
    this.#flushing = true;
    this.#flushPromise = (async () => {
      while (!this.#closed && !this.#superseded) {
        const snapshot = this.#latest;
        if (!this.#pending || snapshot === null) break;
        const result = await this.#transmit(snapshot);
        if (this.#closed || this.#superseded) break;
        if (result === "resend") {
          // The server refused our revision but adopted ours from a lost ACK.
          // The pending snapshot is still unsent: retry immediately at the
          // server's revision + 1. Bounded so a pathological server cannot spin
          // us, then fall back to normal backoff.
          this.#resendStreak += 1;
          if (this.#resendStreak > 3) {
            this.#resendStreak = 0;
            this.#scheduleFlush(this.#nextBackoff());
            break;
          }
          continue;
        }
        this.#resendStreak = 0;
        if (result === "retry") {
          this.#scheduleFlush(this.#nextBackoff());
          break;
        }
        if (this.#latest === snapshot) this.#pending = false;
        if (result === "drop") break;
      }
    })();
    try {
      await this.#flushPromise;
    } finally {
      this.#flushing = false;
      this.#flushPromise = null;
      if (!this.#closed && !this.#superseded && this.#pending && this.#flushTimer === null) {
        this.#scheduleFlush(0);
      }
    }
  }

  #nextBackoff(): number {
    const delay = this.#retryDelayMs;
    this.#retryDelayMs = Math.min(this.#retryMaxMs, Math.max(this.#retryBaseMs, this.#retryDelayMs * 2));
    return delay;
  }

  async #start(): Promise<DashboardAddress> {
    if (this.#address !== null) return this.#address;
    if (this.#startPromise === null) {
      this.#startPromise = (async () => {
        const options: EnsureDashboardOptions = {};
        if (this.#runtimeDir !== undefined) options.runtimeDir = this.#runtimeDir;
        const address = await this.#ensure(options);
        this.#address = address;
        this.#notifyReady(address);
        return address;
      })().finally(() => {
        this.#startPromise = null;
      });
    }
    return this.#startPromise;
  }

  async #transmit(snapshot: DashboardSnapshot): Promise<TransmitResult> {
    try {
      const address = await this.#start();
      const revision = this.#revision + 1;
      const response = await this.#fetch(`${address.url}api/producer/publish`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${address.producerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: snapshot.session.id,
          producerId: this.#producerId,
          generation: this.#generation,
          revision,
          snapshot,
        }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      return await this.#handlePublishResponse(response, revision);
    } catch (error) {
      // Connection failure: the server may have died. Drop the address so the
      // next attempt re-runs discovery/startup instead of hammering a dead port.
      this.#address = null;
      this.#report(error);
      return "retry";
    }
  }

  async #handlePublishResponse(response: Response, revision: number): Promise<TransmitResult> {
    if (response.status === 200) {
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.generation === "number" && Number.isInteger(body.generation)) this.#generation = body.generation;
      this.#revision = revision;
      this.#succeed();
      return "sent";
    }
    if (response.status === 409) {
      // The server has a revision at least as new (e.g. our ACK was lost). Adopt
      // it and resend: the pending snapshot may be NEWER than the one whose ACK
      // was lost, so treating this as "already applied" would silently drop it.
      const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      if (typeof body.revision === "number" && Number.isInteger(body.revision)) {
        this.#revision = Math.max(this.#revision, body.revision);
      }
      if (typeof body.generation === "number" && Number.isInteger(body.generation)) this.#generation = body.generation;
      this.#retryDelayMs = this.#retryBaseMs;
      this.#lastErrorKey = "";
      return "resend";
    }
    if (response.status === 410) {
      this.#supersede();
      return "drop";
    }
    if (response.status === 401) {
      // Token rejected: re-run discovery (a different runtime dir/server may be
      // the live one now) instead of retrying the same credential forever.
      this.#address = null;
      return "retry";
    }
    if (response.status === 404) {
      // Server restarted and no longer knows this lease: republish as a new one.
      this.#generation = 0;
      return "retry";
    }
    if (response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500) {
      return "retry";
    }
    if (response.status === 413) {
      this.#report(new Error("dashboard rejected the snapshot: payload too large"));
      return "drop";
    }
    if (response.status === 400 || response.status === 415) {
      const text = await response.text().catch(() => "");
      this.#report(new Error(`dashboard rejected the snapshot (${response.status}) ${text}`.trim()));
      return "drop";
    }
    this.#report(new Error(`unexpected dashboard response ${response.status}`));
    return "retry";
  }

  #succeed(): void {
    this.#lastAckAt = this.#now();
    this.#retryDelayMs = this.#retryBaseMs;
    this.#lastErrorKey = "";
    this.#resendStreak = 0;
  }

  #stopTimers(): void {
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer);
    if (this.#heartbeatTimer !== null) clearInterval(this.#heartbeatTimer);
    this.#flushTimer = null;
    this.#heartbeatTimer = null;
  }

  #notifyReady(address: DashboardAddress): void {
    // A restarted server gets a new port and a new bootstrap token. Notifying
    // only once would show the user a URL that no longer exists, so notify
    // whenever the URL actually changes; re-notifying the same URL is noise.
    if (this.#lastNotifiedUrl === address.browserUrl) return;
    this.#lastNotifiedUrl = address.browserUrl;
    try {
      this.#onReady?.(address.browserUrl);
    } catch (error) {
      this.#report(error);
    }
  }

  // ── Heartbeat ────────────────────────────────────────────────────────────

  #startHeartbeat(): void {
    if (this.#heartbeatMs <= 0 || this.#heartbeatTimer !== null || this.#closed || this.#superseded) return;
    this.#heartbeatTimer = setInterval(() => {
      void this.#heartbeat();
    }, this.#heartbeatMs);
    this.#heartbeatTimer.unref();
  }

  async #heartbeat(): Promise<void> {
    if (this.#closed || this.#superseded) return;
    if (this.#latest === null) return;
    if (this.#address === null) {
      // The last attempt dropped the connection (network error/401). Heartbeats
      // must not sit on a null address forever: hand control to the flush path,
      // which rediscovers or restarts the server and republishes the snapshot.
      this.#pending = true;
      this.#scheduleFlush(0);
      return;
    }
    if (this.#flushing || this.#pending) return;
    if (this.#now() - this.#lastAckAt < this.#heartbeatMs) return;
    try {
      const address = this.#address;
      const response = await this.#fetch(`${address.url}api/producer/heartbeat`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${address.producerToken}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sessionId: this.#sessionId,
          producerId: this.#producerId,
          generation: this.#generation,
        }),
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if (response.status === 200) {
        this.#succeed();
        return;
      }
      if (response.status === 404) {
        // Server restarted: force a full snapshot republish.
        this.#generation = 0;
        this.#pending = true;
        this.#scheduleFlush(0);
        return;
      }
      if (response.status === 410) {
        this.#supersede();
        return;
      }
      if (response.status === 401) {
        this.#address = null;
        this.#pending = true;
        this.#scheduleFlush(0);
        return;
      }
      // 408/425/429/5xx and anything unexpected: the lease is unconfirmed, so
      // let the flush path re-establish it instead of waiting for the next tick.
      this.#pending = true;
      this.#scheduleFlush(this.#nextBackoff());
    } catch (error) {
      this.#address = null;
      this.#pending = true;
      this.#report(error);
      this.#scheduleFlush(this.#nextBackoff());
    }
  }

  #supersede(): void {
    this.#superseded = true;
    this.#stopTimers();
    this.#report(new Error("dashboard producer was superseded by another producer for this session"));
  }

  async #unregister(): Promise<void> {
    if (this.#address === null) return;
    const address = this.#address;
    await this.#fetch(`${address.url}api/producer/unregister`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${address.producerToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: this.#sessionId,
        producerId: this.#producerId,
        generation: this.#generation,
      }),
      signal: AbortSignal.timeout(CLOSE_TIMEOUT_MS),
    });
  }

  #report(error: unknown): void {
    const key = error instanceof Error ? `${error.name}:${error.message}` : String(error);
    if (key === this.#lastErrorKey) return;
    this.#lastErrorKey = key;
    try {
      this.#onError?.(error);
    } catch {
      // A reporting hook must never break the producer.
    }
  }
}
