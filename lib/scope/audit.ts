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

/**
 * What the audit adds up to.
 *
 * The audit answers "what happened"; this answers "what should I change". A gate
 * that asks too much has a shape — one tool, one folder — and it is only visible
 * once the questions are counted instead of listed. Grouping by tool and by the
 * paths that were asked about most is the input a `/scope allow` or a rule needs.
 */
export function formatStats(entries: readonly AuditEntry[]): string[] {
  if (!entries.length) return ["Scope stats: nothing recorded yet"];
  const counts = new Map<string, { total: number; ask: number; deny: number }>();
  for (const entry of entries) {
    const row = counts.get(entry.tool) ?? { total: 0, ask: 0, deny: 0 };
    row.total++;
    if (entry.outcome === "ask") row.ask++;
    else if (entry.outcome === "deny") row.deny++;
    counts.set(entry.tool, row);
  }
  const asked = entries.filter(entry => entry.outcome === "ask").length;
  const denied = entries.filter(entry => entry.outcome === "deny").length;
  const writes = entries.filter(entry => entry.write).length;
  const lines = [
    `Scope stats: ${entries.length} decisions — ${asked} asked, ${denied} denied, ${entries.length - asked - denied} automatic, ${writes} writes`,
    "by tool (total / asked / denied):",
    ...[...counts.entries()]
      .sort((left, right) => right[1].total - left[1].total)
      .slice(0, 8)
      .map(([tool, row]) => `  ${tool.padEnd(18)} ${String(row.total).padStart(4)} ${String(row.ask).padStart(4)} ${String(row.deny).padStart(4)}`),
  ];
  const askedPaths = new Map<string, number>();
  for (const entry of entries) {
    if (entry.outcome !== "ask") continue;
    askedPaths.set(entry.path, (askedPaths.get(entry.path) ?? 0) + 1);
  }
  const top = [...askedPaths.entries()].sort((left, right) => right[1] - left[1]).slice(0, 5);
  if (top.length) {
    lines.push("most-asked paths (a grant or a rule would silence these):");
    for (const [path, count] of top) lines.push(`  ${String(count).padStart(3)}  ${path}`);
  }
  return lines;
}
