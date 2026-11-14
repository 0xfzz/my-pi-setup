/** Shared wire/view contract. Never include transcripts, terminal tails, or producer secrets. */
/**
 * Wire version.
 *
 * 2 — the delegation collections moved to `snapshot.delegation`, and escalation
 *     stages/actors read `parent`. Bumped so an already-open tab built against
 *     the pre-rename field is
 *     rejected loudly at handshake instead of rendering an empty graph from a
 *     field that no longer exists.
 */
export const SUBAGENT_GRAPH_PROTOCOL = 2 as const;
export const SUBAGENT_GRAPH_MODE_EVENT = "subagent-graph:mode";
export const SUBAGENT_GRAPH_STATE_EVENT = "subagent-graph:state";
export const SUBAGENT_GRAPH_ARTIFACTS_EVENT = "subagent-graph:artifacts";
export const SUBAGENT_GRAPH_REQUEST_EVENT = "subagent-graph:request";

export interface SubagentGraphSessionInfo {
  id: string;
  name: string;
  project: string;
  mode: string;
  branchId?: string;
}
export interface SubagentGraphChild {
  id: string;
  name: string;
  scope: string;
  status: "running" | "completed" | "blocked" | "failed" | "closed";
  purpose?: "implementation" | "review" | "research" | "adhoc";
  task?: string;
  handoffId?: string;
  reviewRunId?: string;
  reviewLens?: string;
  laneFiles: string[];
  lastMilestoneFiles: string[];
  artifactIds?: string[];
  pendingPing?: boolean;
  startedAt?: number;
  budgetMs?: number;
  lastTokens?: number;
  lastContextWindow?: number;
  closeReason?: string;
  supersededIds?: string[];
  updatedAt?: string;
}
export interface SubagentGraphHandoff { id: string; scope: string; goal: string; acceptanceCriteria: string[] }
export interface SubagentGraphReview { id: string; scope: string; verdict: string; summary: string; timestamp?: string }
export interface SubagentGraphEscalation { id: string; childId?: string; scope?: string; question: string; stage: string }
export interface SubagentGraphSpecReview { id: string; title: string; status: string; reviewerIds: string[] }
export interface SubagentGraphDelegation {
  children: SubagentGraphChild[];
  handoffs: SubagentGraphHandoff[];
  reviews: SubagentGraphReview[];
  escalations: SubagentGraphEscalation[];
  specReviews: SubagentGraphSpecReview[];
  paused: boolean;
}
export interface SubagentGraphArtifact {
  id: string;
  title: string;
  type: string;
  content: string;
  version: number;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  tags: string[];
  scope?: string;
  /** Child identifier, when explicitly resolved from artifact provenance. */
  childId?: string;
}
export type SubagentGraphArtifactSummary = Omit<SubagentGraphArtifact, "content">;
export interface SubagentGraphSnapshot {
  session: SubagentGraphSessionInfo;
  delegation: SubagentGraphDelegation;
  artifacts: SubagentGraphArtifact[];
}
export interface SubagentGraphSessionView extends Omit<SubagentGraphSnapshot, "artifacts"> {
  artifacts: SubagentGraphArtifactSummary[];
  connected: boolean;
  lastSeen: number;
  revision: number;
}
export interface SubagentGraphSessionSummary extends SubagentGraphSessionInfo {
  connected: boolean;
  lastSeen: number;
  revision: number;
  workers: { running: number; total: number };
}
export function emptyDelegation(): SubagentGraphDelegation {
  return { children: [], handoffs: [], reviews: [], escalations: [], specReviews: [], paused: false };
}

/** Runtime producer contract (implemented in producer.ts).
 * new SubagentGraphProducer({ onReady(url), onError?(error), runtimeDir?, heartbeatMs? })
 * .publish(snapshot): void — coalescing, nonblocking; starts lazily.
 * .close(): Promise<void> — unregisters this lease; does not stop the shared server.
 *
 * Browser API (same-origin authenticated cookie):
 * GET /api/sessions -> { sessions: SubagentGraphSessionSummary[] }
 * GET /api/session?id=... -> { session: SubagentGraphSessionView }
 * GET /api/artifact?session=...&id=...&version=... -> { artifact: SubagentGraphArtifact }
 * GET /api/events -> SSE message data { type: "changed" }; consumers refresh snapshots.
 * Errors are JSON { error: string }. Unknown entities 404; changed artifact version 409.
 */
