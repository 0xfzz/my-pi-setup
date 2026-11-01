/** Shared wire/view contract. Never include transcripts, terminal tails, or producer secrets. */
export const DASHBOARD_PROTOCOL = 1 as const;
export const DASHBOARD_MODE_EVENT = "dashboard:mode";
export const DASHBOARD_STATE_EVENT = "dashboard:state";
export const DASHBOARD_ARTIFACTS_EVENT = "dashboard:artifacts";
export const DASHBOARD_REQUEST_EVENT = "dashboard:request";

export interface DashboardSessionInfo {
  id: string;
  name: string;
  project: string;
  mode: string;
  branchId?: string;
}
export interface DashboardChild {
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
export interface DashboardHandoff { id: string; scope: string; goal: string; acceptanceCriteria: string[] }
export interface DashboardReview { id: string; scope: string; verdict: string; summary: string; timestamp?: string }
export interface DashboardEscalation { id: string; childId?: string; scope?: string; question: string; stage: string }
export interface DashboardSpecReview { id: string; title: string; status: string; reviewerIds: string[] }
export interface DashboardDelegation {
  children: DashboardChild[];
  handoffs: DashboardHandoff[];
  reviews: DashboardReview[];
  escalations: DashboardEscalation[];
  specReviews: DashboardSpecReview[];
  paused: boolean;
}
export interface DashboardArtifact {
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
export type DashboardArtifactSummary = Omit<DashboardArtifact, "content">;
export interface DashboardSnapshot {
  session: DashboardSessionInfo;
  delegation: DashboardDelegation;
  artifacts: DashboardArtifact[];
}
export interface DashboardSessionView extends Omit<DashboardSnapshot, "artifacts"> {
  artifacts: DashboardArtifactSummary[];
  connected: boolean;
  lastSeen: number;
  revision: number;
}
export interface DashboardSessionSummary extends DashboardSessionInfo {
  connected: boolean;
  lastSeen: number;
  revision: number;
  workers: { running: number; total: number };
}
export function emptyDelegation(): DashboardDelegation {
  return { children: [], handoffs: [], reviews: [], escalations: [], specReviews: [], paused: false };
}

/** Runtime producer contract (implemented in producer.ts).
 * new DashboardProducer({ onReady(url), onError?(error), runtimeDir?, heartbeatMs? })
 * .publish(snapshot): void — coalescing, nonblocking; starts lazily.
 * .close(): Promise<void> — unregisters this lease; does not stop the shared server.
 *
 * Browser API (same-origin authenticated cookie):
 * GET /api/sessions -> { sessions: DashboardSessionSummary[] }
 * GET /api/session?id=... -> { session: DashboardSessionView }
 * GET /api/artifact?session=...&id=...&version=... -> { artifact: DashboardArtifact }
 * GET /api/events -> SSE message data { type: "changed" }; consumers refresh snapshots.
 * Errors are JSON { error: string }. Unknown entities 404; changed artifact version 409.
 */
