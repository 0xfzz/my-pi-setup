/**
 * registry-persistence.ts — crash/restart durability for the v2 registry.
 *
 * The registry is in-memory, so a pi restart used to silently forget every
 * running child: watchers died, escalations went unanswered, and the next
 * session's sv2_running reported "no children". The state is small enough to
 * keep as an atomic, versioned JSON sidecar next to the session.
 */
import { mkdirSync, renameSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { RegistrySnapshot } from "./scope-registry.ts";

export interface PersistedState extends RegistrySnapshot {
  /** Handoff id -> serialized record (scope-isolated work-unit specs). */
  handoffs: Array<{ id: string; record: any; path: string }>;
  /** Open escalation records, so pending questions survive a restart. */
  escalations: any[];
  /**
   * Independent specification reviews.
   *
   * Persisted deliberately: readiness is a claim that a document was reviewed by
   * named lenses at a named revision. Losing it on restart would silently convert
   * an unreviewed design back into an approvable one.
   */
  specReviews?: any[];
}

export function saveRegistrySnapshot(path: string, state: PersistedState): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, path);
  } catch {
    // Persistence is best-effort: losing a sidecar write must never take the
    // session down. The registry itself stays authoritative in memory.
  }
}

export function loadRegistrySnapshot(path: string): PersistedState | undefined {
  try {
    if (!existsSync(path)) return undefined;
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    if (parsed?.version !== 1) return undefined;
    return parsed as PersistedState;
  } catch {
    return undefined;
  }
}
