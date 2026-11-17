/**
 * Bounded, append-only audit log (PRD §7.4, R24). It records lifecycle moves,
 * grants, capability denials, quarantines and vetoes. Old entries drop from the
 * front once the bound is reached; the sequence number keeps counting so a gap
 * is visible to anyone reading the log.
 */

export const AUDIT_KINDS = [
  "discovered",
  "rejected",
  "lifecycle",
  "enabled",
  "disabled",
  "granted",
  "revoked",
  "capability-denied",
  "failure",
  "quarantined",
  "quarantine-cleared",
  "veto",
  "safe-mode",
  "browser-granted",
  "browser-revoked",
] as const;

export type AuditKind = (typeof AUDIT_KINDS)[number];

export interface AuditEntry {
  seq: number;
  at: number;
  kind: AuditKind;
  pluginId: string;
  detail: string;
}

export class AuditLog {
  private readonly limit: number;
  private readonly clock: () => number;
  private readonly entries: AuditEntry[] = [];
  private readonly listeners = new Set<(entry: AuditEntry) => void>();
  private nextSeq = 1;

  constructor(options: { limit?: number; clock?: () => number } = {}) {
    this.limit = options.limit ?? 500;
    this.clock = options.clock ?? Date.now;
  }

  append(kind: AuditKind, pluginId: string, detail: string): AuditEntry {
    const entry: AuditEntry = { seq: this.nextSeq++, at: this.clock(), kind, pluginId, detail };
    this.entries.push(entry);
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
    // A snapshot: a listener that subscribes or unsubscribes during append must
    // not change the set of observers this entry reaches.
    for (const listener of Array.from(this.listeners)) {
      try {
        listener(entry);
      } catch {
        // An observer (the registry broadcast) cannot break the log.
      }
    }
    return entry;
  }

  /**
   * Observe every appended entry. Lifecycle moves all land here, which makes
   * this the one place that sees "the served plugin set may have changed" —
   * an operator action, a boot, a breaker quarantine alike.
   */
  subscribe(listener: (entry: AuditEntry) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Snapshot copy, oldest first. */
  list(filter: { pluginId?: string; kind?: AuditKind } = {}): AuditEntry[] {
    return this.entries
      .filter((e) => (filter.pluginId === undefined || e.pluginId === filter.pluginId) && (filter.kind === undefined || e.kind === filter.kind))
      .map((e) => ({ ...e }));
  }

  /** Entries dropped from the front so far. A non-zero value means the log wrapped. */
  get dropped(): number {
    return this.nextSeq - 1 - this.entries.length;
  }
}
