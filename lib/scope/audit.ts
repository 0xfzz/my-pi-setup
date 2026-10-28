/**
 * Bounded audit log for everything the scope gate decided automatically.
 *
 * The point is the question a user asks five minutes later — "what did it touch
 * while I wasn't looking?" — so entries are kept for auto-approvals (yolo), for
 * questions, and for denials. Bounded, because an unbounded log in a long
 * session is a memory leak that looks like a feature.
 */
export interface AuditEntry {
  at: number;
  tool: string;
  path: string;
  write: boolean;
  outcome: "auto" | "ask" | "deny" | "allowed";
  detail?: string;
}

export class ScopeLog {
  private readonly limit: number;
  private entries: AuditEntry[] = [];

  constructor(limit = 200) {
    this.limit = Math.max(1, Math.floor(limit));
  }

  add(entry: Omit<AuditEntry, "at"> & { at?: number }): void {
    this.entries.push({ at: entry.at ?? Date.now(), ...entry });
    if (this.entries.length > this.limit) this.entries.splice(0, this.entries.length - this.limit);
  }

  list(): readonly AuditEntry[] {
    return this.entries;
  }

  clear(): void {
    this.entries = [];
  }
}

function clock(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** Newest last, one line per decision; `limit` caps what a popup must show. */
export function formatAudit(entries: readonly AuditEntry[], limit = 20): string[] {
  if (!entries.length) return ["Scope log: nothing recorded yet"];
  const shown = entries.slice(Math.max(0, entries.length - limit));
  const lines = shown.map(entry =>
    `${clock(entry.at)}  ${entry.outcome.padEnd(7)} ${entry.write ? "write" : "read "}  ${entry.path}${entry.detail ? `  ${entry.detail}` : ""}`);
  const hidden = entries.length - shown.length;
  if (hidden > 0) lines.unshift(`Scope log (${hidden} older hidden)`);
  return lines;
}
