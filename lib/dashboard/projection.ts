/**
 * projection — the allowlist between live extension state and the wire snapshot.
 *
 * The dashboard is an observer. Everything it can display is chosen here, by
 * naming the fields that may cross the boundary, never by stripping a copy of an
 * internal record. Registry rows carry session file paths, terminal tails and
 * watchdog bookkeeping; those are diagnostics for the orchestrator, not dashboard
 * data, and an allowlist is the only shape that keeps a future field from leaking
 * by default.
 *
 * Relationships are copied only when an identifier already states them. A child's
 * `handoffId`, an artifact's `sourceSession`, and a review slot's `childId` are
 * provenance. Names, scopes, or similar-looking strings are not.
 */
import { basename } from "node:path";
import { resolveGoalTitle } from "./goal-title.ts";
import {
  emptyOrchestrator,
  type DashboardArtifact,
  type DashboardChild,
  type DashboardEscalation,
  type DashboardHandoff,
  type DashboardOrchestrator,
  type DashboardReview,
  type DashboardSessionInfo,
  type DashboardSnapshot,
  type DashboardSpecReview,
} from "./protocol.ts";

/** Generous caps: a live run is small, but a corrupted sidecar must not be. */
export const DASHBOARD_LIMITS = {
  children: 128,
  handoffs: 128,
  reviews: 64,
  escalations: 64,
  specReviews: 64,
  artifacts: 256,
} as const;

/** A source-side artifact record. `sourceSession` is internal provenance. */
export interface DashboardArtifactRecord extends DashboardArtifact {
  /** Session file that produced the artifact, when the record carries one. */
  sourceSession?: string;
}

export interface OrchestratorProjectionInput {
  children?: readonly any[] | null;
  handoffs?: readonly any[] | Map<string, { record?: any }> | null;
  reviews?: readonly any[] | null;
  escalations?: readonly any[] | null;
  specReviews?: readonly any[] | null;
  paused?: boolean;
}

export interface ProjectArtifactsOptions {
  /** Explicit child id by session file. Missing entries mean "no association". */
  childBySession?: ReadonlyMap<string, string> | null;
  limit?: number;
}

const STATUSES = new Set(["running", "completed", "blocked", "failed", "closed"]);
const PURPOSES = new Set(["implementation", "review", "research", "adhoc"]);

function text(value: unknown, max = 4096): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

function stringList(value: unknown, maxItems = 256): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!item) continue;
    out.push(text(item, 512));
    if (out.length >= maxItems) break;
  }
  return out;
}

function finitePositive(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function optionalText(value: unknown, max = 1024): string | undefined {
  const result = text(value, max);
  return result ? result : undefined;
}

function entriesOf<T>(value: readonly T[] | Map<string, T> | null | undefined): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value as T[];
  if (value instanceof Map) return [...value.values()];
  return [];
}

/**
 * A registry row, reduced to the protocol's child fields.
 *
 * Deliberately absent: sessionFile, lastTail, stallStrikes, watchdog, specPath,
 * frozenCriteria, launchScriptFile, interactive/autoExit. Those either identify a
 * private file, contain terminal content, or describe orchestrator control.
 */
export function projectChild(raw: any): DashboardChild | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const status = STATUSES.has(raw.status) ? raw.status : "closed";
  const child: DashboardChild = {
    id: text(raw.id, 200),
    name: text(raw.name, 200),
    scope: text(raw.scope, 128),
    status: status as DashboardChild["status"],
    laneFiles: stringList(raw.laneFiles),
    lastMilestoneFiles: stringList(raw.lastMilestoneFiles),
  };
  if (PURPOSES.has(raw.purpose)) child.purpose = raw.purpose;
  const task = optionalText(raw.task);
  if (task) child.task = task;
  const handoffId = optionalText(raw.handoffId, 200);
  if (handoffId) child.handoffId = handoffId;
  const reviewRunId = optionalText(raw.reviewRunId, 200);
  if (reviewRunId) child.reviewRunId = reviewRunId;
  const reviewLens = optionalText(raw.reviewLens, 100);
  if (reviewLens) child.reviewLens = reviewLens;
  if (Array.isArray(raw.artifactIds)) child.artifactIds = stringList(raw.artifactIds);
  if (raw.pendingPing === true) child.pendingPing = true;
  const startedAt = finitePositive(raw.startedAt);
  if (startedAt !== undefined) child.startedAt = startedAt;
  const budgetMs = finitePositive(raw.budgetMs);
  if (budgetMs !== undefined) child.budgetMs = budgetMs;
  const lastTokens = finitePositive(raw.lastTokens);
  if (lastTokens !== undefined) child.lastTokens = lastTokens;
  const lastContextWindow = finitePositive(raw.lastContextWindow);
  if (lastContextWindow !== undefined) child.lastContextWindow = lastContextWindow;
  const closeReason = optionalText(raw.closeReason, 100);
  if (closeReason) child.closeReason = closeReason;
  if (Array.isArray(raw.supersededIds)) child.supersededIds = stringList(raw.supersededIds);
  const updatedAt = optionalText(raw.updatedAt, 100);
  if (updatedAt) child.updatedAt = updatedAt;
  return child;
}

/** Session-file → child id, copied from the registry's explicit row identity. */
export function projectChildProvenance(children: readonly any[] | null | undefined): Map<string, string> {
  const map = new Map<string, string>();
  for (const raw of children ?? []) {
    if (!raw || typeof raw !== "object") continue;
    if (typeof raw.sessionFile !== "string" || !raw.sessionFile) continue;
    if (typeof raw.id !== "string" || !raw.id) continue;
    map.set(raw.sessionFile, raw.id);
  }
  return map;
}

function projectHandoff(raw: any): DashboardHandoff | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  return {
    id: text(raw.id, 200),
    scope: text(raw.scope, 128),
    goal: text(raw.goal, 4096),
    acceptanceCriteria: stringList(raw.acceptanceCriteria, 64).map(item => text(item, 2048)),
  };
}

function projectReview(raw: any): DashboardReview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const review: DashboardReview = {
    id: text(raw.id, 200),
    scope: text(raw.scope, 128),
    verdict: text(raw.verdict, 64),
    summary: text(raw.summary, 4096),
  };
  const timestamp = optionalText(raw.timestamp, 100);
  if (timestamp) review.timestamp = timestamp;
  return review;
}

function projectEscalation(raw: any): DashboardEscalation | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const escalation: DashboardEscalation = {
    id: text(raw.id, 200),
    question: text(raw.question, 4096),
    stage: text(raw.stage, 64),
  };
  const childId = optionalText(raw.childId, 200);
  if (childId) escalation.childId = childId;
  const scope = optionalText(raw.scope, 128);
  if (scope) escalation.scope = scope;
  return escalation;
}

function projectSpecReview(raw: any): DashboardSpecReview | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  const reviewerIds: string[] = [];
  for (const slot of Array.isArray(raw.reviewers) ? raw.reviewers : []) {
    // Only a recorded child id establishes the reviewer relationship. A lens or
    // scope name is not a child identifier, and guessing one would invent an edge.
    if (typeof slot?.childId === "string" && slot.childId) reviewerIds.push(text(slot.childId, 200));
    if (reviewerIds.length >= 32) break;
  }
  return {
    id: text(raw.id, 200),
    title: text(raw.target?.title ?? raw.title, 512),
    status: text(raw.status, 64),
    reviewerIds,
  };
}

/** Project the orchestrator collections, keeping the newest rows when capped. */
export function projectOrchestrator(input: OrchestratorProjectionInput): DashboardOrchestrator {
  const children = (input.children ?? [])
    .map(projectChild)
    .filter((child): child is DashboardChild => Boolean(child))
    .slice(-DASHBOARD_LIMITS.children);
  const handoffRecords = entriesOf(input.handoffs)
    .map(entry => projectHandoff(entry?.record ?? entry))
    .filter((handoff): handoff is DashboardHandoff => Boolean(handoff))
    .slice(-DASHBOARD_LIMITS.handoffs);
  const reviews = (input.reviews ?? [])
    .map(projectReview)
    .filter((review): review is DashboardReview => Boolean(review))
    .slice(-DASHBOARD_LIMITS.reviews);
  const escalations = (input.escalations ?? [])
    .map(projectEscalation)
    .filter((escalation): escalation is DashboardEscalation => Boolean(escalation))
    .slice(-DASHBOARD_LIMITS.escalations);
  const specReviews = (input.specReviews ?? [])
    .map(projectSpecReview)
    .filter((review): review is DashboardSpecReview => Boolean(review))
    .slice(-DASHBOARD_LIMITS.specReviews);
  return {
    ...emptyOrchestrator(),
    children,
    handoffs: handoffRecords,
    reviews,
    escalations,
    specReviews,
    paused: input.paused === true,
  };
}

/** Internal source record → allowlisted artifact fields, retaining provenance. */
export function toArtifactRecord(raw: any): DashboardArtifactRecord | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id) return undefined;
  if (typeof raw.content !== "string") return undefined;
  const record: DashboardArtifactRecord = {
    id: text(raw.id, 200),
    title: text(raw.title, 512),
    type: text(raw.type, 64),
    content: raw.content,
    version: typeof raw.version === "number" && raw.version > 0 ? Math.floor(raw.version) : 1,
    createdBy: text(raw.createdBy, 200),
    createdAt: text(raw.createdAt, 100),
    updatedAt: text(raw.updatedAt, 100),
    tags: stringList(raw.tags, 64),
  };
  const scope = optionalText(raw.scope, 128);
  if (scope) record.scope = scope;
  if (typeof raw.sourceSession === "string" && raw.sourceSession) record.sourceSession = raw.sourceSession;
  const explicitChild = optionalText(raw.childId, 200);
  if (explicitChild) record.childId = explicitChild;
  return record;
}

/**
 * Artifacts for the wire, with child association only from explicit provenance.
 *
 * `sourceSession` is resolved through the registry map built from rows, so an
 * artifact belongs to a child only if that child's row names the session the
 * artifact says produced it. Everything else stays unassociated rather than
 * inferred from names.
 */
export function projectArtifacts(
  records: readonly DashboardArtifactRecord[] | null | undefined,
  options: ProjectArtifactsOptions = {},
): DashboardArtifact[] {
  const limit = options.limit ?? DASHBOARD_LIMITS.artifacts;
  const list: DashboardArtifact[] = [];
  for (const raw of records ?? []) {
    const record = toArtifactRecord(raw);
    if (!record) continue;
    const { sourceSession, ...wire } = record;
    const childId = wire.childId ?? (sourceSession ? options.childBySession?.get(sourceSession) : undefined);
    if (childId) wire.childId = childId;
    else delete wire.childId;
    list.push(wire);
  }
  list.sort((a, b) => a.id.localeCompare(b.id));
  return list.length > limit ? list.slice(0, limit) : list;
}

/**
 * Session metadata for the wire. Absolute paths are reduced to a project name.
 *
 * The published `name` is the branch's current goal title, without a Manager
 * suffix. The browser derives the graph manager label separately. Raw ids,
 * transcripts, scratch plans and foreign session records are never titles.
 */
export function projectSession(context: any, mode: string, fallbackId = "unknown"): DashboardSessionInfo {
  const manager = context?.sessionManager;
  const id = typeof manager?.getSessionId === "function" ? String(manager.getSessionId() || fallbackId) : fallbackId;
  const name = typeof manager?.getSessionName === "function" ? manager.getSessionName() : undefined;
  const cwd = typeof manager?.getCwd === "function" ? manager.getCwd() : undefined;
  const branch = typeof manager?.getBranch === "function" ? manager.getBranch() : [];
  const header = typeof manager?.getHeader === "function" ? manager.getHeader() : undefined;
  const branchName = [...branch].reverse().find((entry: any) => entry.type === "session_info");
  // Pi's getSessionName() is file-global. With the real API, only active-branch
  // session_info may supply a name; an abandoned branch must not leak its title.
  const currentName = header?.parentSession ? undefined : branchName ? branchName.name
    : typeof manager?.getEntries === "function" ? undefined : name;
  const branchId = typeof manager?.getLeafId === "function" ? manager.getLeafId() : undefined;
  const project = text(cwd ? basename(String(cwd)) : "unknown", 200);
  const info: DashboardSessionInfo = {
    id,
    name: resolveGoalTitle({ branch, ownerSessionId: id, project,
      sessionName: typeof currentName === "string" ? currentName : undefined }),
    project,
    mode: text(mode || "normal", 64) || "normal",
  };
  if (typeof branchId === "string" && branchId) info.branchId = branchId;
  return info;
}

/** Final assembly. Inputs are already projected; this only copies them into one snapshot. */
export function projectSnapshot(input: {
  session: DashboardSessionInfo;
  orchestrator?: DashboardOrchestrator;
  artifacts?: readonly DashboardArtifact[];
}): DashboardSnapshot {
  return {
    session: { ...input.session },
    orchestrator: input.orchestrator ? {
      children: input.orchestrator.children.map(child => ({ ...child })),
      handoffs: input.orchestrator.handoffs.map(handoff => ({ ...handoff })),
      reviews: input.orchestrator.reviews.map(review => ({ ...review })),
      escalations: input.orchestrator.escalations.map(escalation => ({ ...escalation })),
      specReviews: input.orchestrator.specReviews.map(review => ({ ...review })),
      paused: input.orchestrator.paused === true,
    } : emptyOrchestrator(),
    artifacts: (input.artifacts ?? []).map(artifact => ({ ...artifact })),
  };
}
