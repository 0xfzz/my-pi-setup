/**
 * integration — the in-process bridge between extension state and the shared
 * dashboard producer.
 *
 * Rules this file exists to enforce:
 *
 * 1. Notifications, not direct calls. modes/delegation/artifacts publish on the
 *    existing `pi.events` bus, so the dashboard extension can load before or
 *    after them without either side importing the other.
 * 2. Observation is cheap and idempotent. Anything arriving before the producer
 *    starts is retained; a `dashboard:request` handshake asks publishers to
 *    re-emit current state, so load order cannot lose the initial snapshot.
 * 3. Nothing here can block orchestration. Producer creation is lazy, updates are
 *    coalesced, and every call into the producer is wrapped: a dashboard failure
 *    is reported and dropped.
 * 4. This producer is a lease. `close()` releases only this session's producer;
 *    the shared server and other sessions are owned elsewhere.
 */
import {
  DASHBOARD_ARTIFACTS_EVENT,
  DASHBOARD_MODE_EVENT,
  DASHBOARD_STATE_EVENT,
  emptyDelegation,
  type DashboardDelegation,
  type DashboardSessionInfo,
  type DashboardSnapshot,
} from "./protocol.ts";
import {
  projectArtifacts,
  projectSnapshot,
  type DashboardArtifactRecord,
} from "./projection.ts";

/**
 * Local request channel. `dashboard:request` arrives from the server/UI; this
 * one is the bridge asking every publisher to state what it currently has.
 */
export const DASHBOARD_SYNC_EVENT = "dashboard:sync";

export interface DashboardModeNotice {
  mode: string;
  at: number;
}

export interface DashboardStateNotice {
  delegation: DashboardDelegation;
  /** Explicit session-file → child-id provenance from the registry rows. */
  childSessions?: ReadonlyMap<string, string>;
  at: number;
}

export interface DashboardArtifactsNotice {
  artifacts: DashboardArtifactRecord[];
  at: number;
}

export interface DashboardEventSource {
  events?: {
    emit(channel: string, data: unknown): void;
    on?(channel: string, handler: (data: unknown) => void): () => void;
  };
}

function emit(pi: DashboardEventSource | undefined, channel: string, data: unknown): void {
  try {
    pi?.events?.emit(channel, data);
  } catch {
    // A listener throwing must never break the extension that was reporting.
  }
}

export function publishDashboardMode(pi: DashboardEventSource | undefined, mode: string): void {
  if (!mode) return;
  emit(pi, DASHBOARD_MODE_EVENT, { mode, at: Date.now() } satisfies DashboardModeNotice);
}

export function publishDashboardState(
  pi: DashboardEventSource | undefined,
  notice: Omit<DashboardStateNotice, "at"> & { at?: number },
): void {
  emit(pi, DASHBOARD_STATE_EVENT, {
    delegation: notice.delegation,
    ...(notice.childSessions ? { childSessions: notice.childSessions } : {}),
    at: notice.at ?? Date.now(),
  } satisfies DashboardStateNotice);
}

export function publishDashboardArtifacts(
  pi: DashboardEventSource | undefined,
  artifacts: readonly DashboardArtifactRecord[],
): void {
  emit(pi, DASHBOARD_ARTIFACTS_EVENT, {
    artifacts: [...artifacts],
    at: Date.now(),
  } satisfies DashboardArtifactsNotice);
}

/** Ask every loaded publisher to re-emit its current state. Synchronous by design. */
export function requestDashboardSync(pi: DashboardEventSource | undefined): void {
  emit(pi, DASHBOARD_SYNC_EVENT, { at: Date.now() });
}

export interface DashboardProducerOptions {
  onReady?: (url: string) => void;
  onError?: (error: unknown) => void;
  runtimeDir?: string;
  heartbeatMs?: number;
}

export interface DashboardProducerLike {
  publish(snapshot: DashboardSnapshot): void;
  close(): Promise<void> | void;
}

export type DashboardProducerFactory = (
  options: DashboardProducerOptions,
) => DashboardProducerLike | Promise<DashboardProducerLike>;

/**
 * Default runtime factory. Kept behind a seam so tests can inject a fake producer
 * and so a package without the shared runtime still loads safely: the import is
 * deferred until the first delegated child actually needs it.
 */
export async function defaultDashboardProducerFactory(
  options: DashboardProducerOptions,
): Promise<DashboardProducerLike> {
  // Non-literal on purpose: lib/dashboard/producer.ts is owned by the shared
  // runtime lane, so this file must not fail to resolve before it lands.
  const specifier = "./producer" + ".ts";
  const module: any = await import(new URL(specifier, import.meta.url).href);
  const Producer = module?.DashboardProducer;
  if (typeof Producer !== "function") {
    throw new Error("DashboardProducer is not available in lib/dashboard/producer.ts");
  }
  return new Producer(options);
}

export interface DashboardBridgeOptions {
  producerFactory: DashboardProducerFactory;
  /** Coalescing window for mutation updates. Default 100ms. */
  coalesceMs?: number;
  runtimeDir?: string;
  heartbeatMs?: number;
  onError?: (error: unknown) => void;
  onReady?: (url: string) => void;
}

/**
 * One producer lease for one parent session.
 *
 * `start()` is the only thing that creates the producer, and the dashboard
 * extension calls it only after the first child is registered or a branch restore. Every
 * mutation before that is retained in `mode`/`delegation`/`artifacts`, so the
 * first snapshot published is the current state rather than an empty shell.
 */
export class DashboardBridge {
  private readonly options: DashboardBridgeOptions;
  private session: DashboardSessionInfo | undefined;
  private mode = "normal";
  private delegation: DashboardDelegation | undefined;
  private childSessions: ReadonlyMap<string, string> | undefined;
  private artifactRecords: DashboardArtifactRecord[] = [];
  private producer: DashboardProducerLike | undefined;
  private starting: Promise<void> | undefined;
  private closed = false;
  private generation = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastSignature: string | undefined;
  private readyUrl: string | undefined;

  constructor(options: DashboardBridgeOptions) {
    this.options = options;
  }

  get started(): boolean {
    return this.producer !== undefined;
  }

  get url(): string | undefined {
    return this.readyUrl;
  }

  setSession(session: DashboardSessionInfo): void {
    this.session = { ...session };
    if (this.producer) this.schedule();
  }

  observeMode(mode: string): void {
    if (!mode || mode === this.mode) return;
    this.mode = mode;
    if (this.producer) this.schedule();
  }

  observeDelegation(
    delegation: DashboardDelegation | undefined,
    childSessions?: ReadonlyMap<string, string>,
  ): void {
    this.delegation = delegation;
    if (childSessions) this.childSessions = childSessions;
    if (this.producer) this.schedule();
  }

  observeArtifacts(records: readonly DashboardArtifactRecord[] | undefined): void {
    this.artifactRecords = [...(records ?? [])];
    if (this.producer) this.schedule();
  }

  /**
   * Create this session's producer if it does not exist yet, then publish the
   * current snapshot. Repeated calls (re-entry, reload) deduplicate: the factory
   * runs once, and the existing lease is reused.
   */
  start(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.producer) {
      this.publishNow();
      return Promise.resolve();
    }
    if (this.starting) return this.starting;
    const generation = ++this.generation;
    this.starting = (async () => {
      try {
        const producer = await this.options.producerFactory({
          onReady: (url) => {
            if (this.closed || generation !== this.generation) return;
            this.readyUrl = url;
            this.options.onReady?.(url);
          },
          onError: (error) => this.report(error),
          ...(this.options.runtimeDir ? { runtimeDir: this.options.runtimeDir } : {}),
          ...(this.options.heartbeatMs !== undefined ? { heartbeatMs: this.options.heartbeatMs } : {}),
        });
        if (!producer || typeof producer.publish !== "function") {
          throw new Error("dashboard producer factory returned no publish()");
        }
        if (this.closed || generation !== this.generation) {
          await producer.close?.();
          return;
        }
        this.producer = producer;
        this.publishNow(true);
      } catch (error) {
        this.report(error);
      }
    })().finally(() => {
      if (generation === this.generation) this.starting = undefined;
    });
    return this.starting;
  }

  /** Publish immediately, cancelling any pending coalesced update. */
  flush(force = true): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    // A handshake asks for current state, not for "state that changed since the
    // last publish". Forcing is what makes reconnect/load-order recovery work.
    this.publishNow(force);
  }

  /** Coalesce mutation updates into one publish inside the configured window. */
  schedule(): void {
    if (!this.producer || this.closed || this.timer) return;
    const wait = Math.max(0, this.options.coalesceMs ?? 100);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.publishNow();
    }, wait);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as any).unref?.();
    }
  }

  /** Release only this lease. A later `reopen()` may start a new one. */
  async close(): Promise<void> {
    this.closed = true;
    this.generation++;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    const producer = this.producer;
    this.producer = undefined;
    this.starting = undefined;
    this.lastSignature = undefined;
    if (producer) {
      try {
        await producer.close?.();
      } catch (error) {
        this.report(error);
      }
    }
  }

  /** A new session in the same Pi process after `session_shutdown`. */
  reopen(): void {
    // After a shutdown this is a different session: do not let the previous
    // session's last observation masquerade as the new one while publishers are
    // still answering the handshake.
    if (this.closed) {
      this.session = undefined;
      this.mode = "normal";
      this.delegation = undefined;
      this.childSessions = undefined;
      this.artifactRecords = [];
      this.readyUrl = undefined;
    }
    this.closed = false;
    this.lastSignature = undefined;
  }

  snapshot(): DashboardSnapshot | undefined {
    if (!this.session) return undefined;
    const session: DashboardSessionInfo = { ...this.session, mode: this.mode || this.session.mode };
    return projectSnapshot({
      session,
      delegation: this.delegation ?? emptyDelegation(),
      artifacts: projectArtifacts(this.artifactRecords, { childBySession: this.childSessions }),
    });
  }

  private signature(snapshot: DashboardSnapshot): string {
    const artifacts = snapshot.artifacts.map(artifact =>
      `${artifact.id}:${artifact.version}:${artifact.updatedAt}:${artifact.childId ?? ""}`).join(",");
    return JSON.stringify({
      session: snapshot.session,
      mode: snapshot.session.mode,
      delegation: snapshot.delegation,
      artifacts,
    });
  }

  private publishNow(force = false): void {
    if (this.closed || !this.producer || !this.session) return;
    const snapshot = this.snapshot();
    if (!snapshot) return;
    const signature = this.signature(snapshot);
    if (!force && signature === this.lastSignature) return;
    this.lastSignature = signature;
    try {
      // Nonblocking by contract: the producer queues/coalesces internally. A
      // throw here is a dashboard failure, never an orchestration failure.
      this.producer.publish(snapshot);
    } catch (error) {
      this.report(error);
    }
  }

  private report(error: unknown): void {
    try {
      this.options.onError?.(error);
    } catch {
      // Error reporting itself must not throw into a publishing extension.
    }
  }
}
