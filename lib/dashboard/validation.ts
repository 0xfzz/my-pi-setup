/**
 * validation.ts — project untrusted producer snapshots onto the dashboard protocol.
 *
 * Producers are authenticated, but authentication proves *who* sent a payload,
 * not that the payload is sane. A buggy bridge could publish a 500 MB string, a
 * prototype-polluting object, an unbounded child list, or a status the browser
 * does not understand. Every byte of that would otherwise reach the browser and
 * the server's session store, so the server never stores a raw snapshot: it
 * stores the result of `sanitizeSnapshot`.
 *
 * Two different failure modes, deliberately separated:
 *
 *   - **Fatal** (`ValidationError`): the payload cannot be trusted as a whole.
 *     A missing session identity, an oversized artifact body, or a non-object
 *     envelope is rejected and the previous session state is left untouched.
 *   - **Dropped**: a single malformed child/handoff/artifact entry is skipped
 *     while the rest of the snapshot is kept. One bad worker record must not
 *     blank the whole dashboard.
 *
 * Sanitizing is a *projection*, not a repair: unknown fields are not copied, so
 * a producer cannot smuggle extra keys (including `__proto__`) into server state
 * or browser JSON. Strings are capped, control characters that can rewrite a
 * terminal are stripped, and arrays are bounded.
 */
import type {
  DashboardArtifact,
  DashboardChild,
  DashboardEscalation,
  DashboardHandoff,
  DashboardMainAgent,
  DashboardReview,
  DashboardSessionInfo,
  DashboardSnapshot,
  DashboardSpecReview,
} from "./protocol.ts";
import { emptyMainAgent } from "./protocol.ts";

/** Hard ceiling for one producer publish body. Matches the server read cap. */
export const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
/** Hard ceiling for one artifact body carried inside a snapshot. */
export const MAX_ARTIFACT_BYTES = 2 * 1024 * 1024;
export const MAX_ID_LENGTH = 256;
export const MAX_NAME_LENGTH = 512;
export const MAX_TEXT_LENGTH = 8192;
export const MAX_SHORT_LENGTH = 1024;
export const MAX_CHILD_LIST = 2048;
export const MAX_ARTIFACT_LIST = 512;
export const MAX_HANDOFF_LIST = 512;
export const MAX_REVIEW_LIST = 2048;
export const MAX_ESCALATION_LIST = 256;
export const MAX_SPEC_REVIEW_LIST = 256;
export const MAX_LANE_FILES = 512;
export const MAX_TAGS = 64;
export const MAX_ACCEPTANCE = 128;
export const MAX_REVIEWER_IDS = 64;
export const MAX_SUPERSEDED = 256;

/** Thrown when a payload cannot be represented at all. `status` is the HTTP status the server reports. */
export class ValidationError extends Error {
  readonly status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "ValidationError";
    this.status = status;
  }
}

const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
// C0 controls except tab/newline/carriage-return, plus DEL. These are the bytes
// that let a hostile name clear a line or inject an escape sequence into logs.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;
const CHILD_STATUSES = new Set(["running", "completed", "blocked", "failed", "closed"]);
const CHILD_PURPOSES = new Set(["implementation", "review"]);

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Optional string: missing/wrong type becomes undefined; empties are kept out. */
function optionalText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(CONTROL_CHARS, "");
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

function optionalId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return ID_PATTERN.test(value) && value.length <= MAX_ID_LENGTH ? value : undefined;
}

function requiredId(value: unknown, what: string, status = 400): string {
  const id = optionalId(value);
  if (id === undefined) throw new ValidationError(`invalid ${what}`, status);
  return id;
}

function optionalNumber(value: unknown, min = 0): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  return value;
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A bounded array; non-arrays become `[]` so a truncated list is not fatal. */
function arrayOf<T>(value: unknown, max: number, each: (entry: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const entry of value) {
    if (out.length >= max) break;
    const item = each(entry);
    if (item !== null) out.push(item);
  }
  return out;
}

function stringList(value: unknown, max: number, maxLength = MAX_SHORT_LENGTH): string[] {
  return arrayOf(value, max, entry => {
    const text = optionalText(entry, maxLength);
    return text === undefined || text === "" ? null : text;
  });
}

function idList(value: unknown, max: number): string[] {
  return arrayOf(value, max, entry => optionalId(entry) ?? null);
}

function sanitizeSession(value: unknown): DashboardSessionInfo {
  if (!isDict(value)) throw new ValidationError("snapshot.session must be an object");
  const info: DashboardSessionInfo = {
    id: requiredId(value.id, "snapshot.session.id"),
    name: optionalText(value.name, MAX_NAME_LENGTH) ?? "",
    project: optionalText(value.project, MAX_NAME_LENGTH) ?? "",
    mode: optionalText(value.mode, MAX_SHORT_LENGTH) ?? "",
  };
  const branchId = optionalText(value.branchId, MAX_ID_LENGTH);
  if (branchId) info.branchId = branchId;
  return info;
}

function sanitizeChild(value: unknown): DashboardChild | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  const scope = optionalId(value.scope);
  // A child without identity or with an unknown status is not representable as
  // v1 protocol data. Dropping it is more honest than inventing a status.
  const status = typeof value.status === "string" && CHILD_STATUSES.has(value.status) ? value.status : null;
  if (id === undefined || scope === undefined || status === null) return null;

  const child: DashboardChild = {
    id,
    name: optionalText(value.name, MAX_NAME_LENGTH) ?? scope,
    scope,
    status: status as DashboardChild["status"],
    laneFiles: stringList(value.laneFiles, MAX_LANE_FILES, MAX_ID_LENGTH),
    lastMilestoneFiles: stringList(value.lastMilestoneFiles, MAX_LANE_FILES, MAX_ID_LENGTH),
  };
  const purpose = typeof value.purpose === "string" && CHILD_PURPOSES.has(value.purpose) ? value.purpose : null;
  if (purpose !== null) child.purpose = purpose as DashboardChild["purpose"];
  const task = optionalText(value.task, MAX_TEXT_LENGTH);
  if (task) child.task = task;
  const handoffId = optionalId(value.handoffId);
  if (handoffId) child.handoffId = handoffId;
  const reviewRunId = optionalId(value.reviewRunId);
  if (reviewRunId) child.reviewRunId = reviewRunId;
  const reviewLens = optionalText(value.reviewLens, MAX_SHORT_LENGTH);
  if (reviewLens) child.reviewLens = reviewLens;
  const artifactIds = idList(value.artifactIds, MAX_ARTIFACT_LIST);
  if (artifactIds.length > 0) child.artifactIds = artifactIds;
  const pendingPing = optionalBoolean(value.pendingPing);
  if (pendingPing !== undefined) child.pendingPing = pendingPing;
  const startedAt = optionalNumber(value.startedAt);
  if (startedAt !== undefined) child.startedAt = startedAt;
  const budgetMs = optionalNumber(value.budgetMs);
  if (budgetMs !== undefined) child.budgetMs = budgetMs;
  const lastTokens = optionalNumber(value.lastTokens);
  if (lastTokens !== undefined) child.lastTokens = lastTokens;
  const lastContextWindow = optionalNumber(value.lastContextWindow);
  if (lastContextWindow !== undefined) child.lastContextWindow = lastContextWindow;
  const closeReason = optionalText(value.closeReason, MAX_TEXT_LENGTH);
  if (closeReason) child.closeReason = closeReason;
  const supersededIds = idList(value.supersededIds, MAX_SUPERSEDED);
  if (supersededIds.length > 0) child.supersededIds = supersededIds;
  const updatedAt = optionalText(value.updatedAt, MAX_SHORT_LENGTH);
  if (updatedAt) child.updatedAt = updatedAt;
  return child;
}

function sanitizeHandoff(value: unknown): DashboardHandoff | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  const scope = optionalId(value.scope);
  if (id === undefined || scope === undefined) return null;
  return {
    id,
    scope,
    goal: optionalText(value.goal, MAX_TEXT_LENGTH) ?? "",
    acceptanceCriteria: stringList(value.acceptanceCriteria, MAX_ACCEPTANCE, MAX_TEXT_LENGTH),
  };
}

function sanitizeReview(value: unknown): DashboardReview | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  const scope = optionalId(value.scope);
  if (id === undefined || scope === undefined) return null;
  const review: DashboardReview = {
    id,
    scope,
    verdict: optionalText(value.verdict, MAX_SHORT_LENGTH) ?? "unknown",
    summary: optionalText(value.summary, MAX_TEXT_LENGTH) ?? "",
  };
  const timestamp = optionalText(value.timestamp, MAX_SHORT_LENGTH);
  if (timestamp) review.timestamp = timestamp;
  return review;
}

function sanitizeEscalation(value: unknown): DashboardEscalation | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  if (id === undefined) return null;
  const escalation: DashboardEscalation = {
    id,
    question: optionalText(value.question, MAX_TEXT_LENGTH) ?? "",
    stage: optionalText(value.stage, MAX_SHORT_LENGTH) ?? "unknown",
  };
  const childId = optionalId(value.childId);
  if (childId) escalation.childId = childId;
  const scope = optionalId(value.scope);
  if (scope) escalation.scope = scope;
  return escalation;
}

function sanitizeSpecReview(value: unknown): DashboardSpecReview | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  if (id === undefined) return null;
  return {
    id,
    title: optionalText(value.title, MAX_NAME_LENGTH) ?? "",
    status: optionalText(value.status, MAX_SHORT_LENGTH) ?? "unknown",
    reviewerIds: idList(value.reviewerIds, MAX_REVIEWER_IDS),
  };
}

function sanitizeMainAgent(value: unknown): DashboardMainAgent {
  if (!isDict(value)) return emptyMainAgent();
  return {
    children: arrayOf(value.children, MAX_CHILD_LIST, sanitizeChild),
    handoffs: arrayOf(value.handoffs, MAX_HANDOFF_LIST, sanitizeHandoff),
    reviews: arrayOf(value.reviews, MAX_REVIEW_LIST, sanitizeReview),
    escalations: arrayOf(value.escalations, MAX_ESCALATION_LIST, sanitizeEscalation),
    specReviews: arrayOf(value.specReviews, MAX_SPEC_REVIEW_LIST, sanitizeSpecReview),
    paused: optionalBoolean(value.paused) ?? false,
  };
}

function sanitizeArtifact(value: unknown): DashboardArtifact | null {
  if (!isDict(value)) return null;
  const id = optionalId(value.id);
  if (id === undefined) return null;
  if (typeof value.content !== "string") return null;
  // oxlint-disable-next-line no-control-regex
  const content = value.content.replace(/\u0000/g, "");
  if (Buffer.byteLength(content, "utf8") > MAX_ARTIFACT_BYTES) {
    // Oversized bodies are fatal: silently truncating a document would present
    // partial text as the authoritative version.
    throw new ValidationError(`artifact ${id} exceeds ${MAX_ARTIFACT_BYTES} bytes`, 413);
  }
  const version = optionalNumber(value.version, 0);
  if (version === undefined || !Number.isInteger(version)) return null;
  const artifact: DashboardArtifact = {
    id,
    title: optionalText(value.title, MAX_NAME_LENGTH) ?? id,
    type: optionalText(value.type, MAX_SHORT_LENGTH) ?? "markdown",
    content,
    version,
    createdBy: optionalText(value.createdBy, MAX_SHORT_LENGTH) ?? "unknown",
    createdAt: optionalText(value.createdAt, MAX_SHORT_LENGTH) ?? "",
    updatedAt: optionalText(value.updatedAt, MAX_SHORT_LENGTH) ?? "",
    tags: stringList(value.tags, MAX_TAGS, MAX_SHORT_LENGTH),
  };
  const scope = optionalId(value.scope);
  if (scope) artifact.scope = scope;
  const childId = optionalId(value.childId);
  if (childId) artifact.childId = childId;
  return artifact;
}

/**
 * Sanitize one producer payload into the exact protocol shape.
 * Throws `ValidationError` for payloads that cannot be represented at all.
 */
export function sanitizeSnapshot(value: unknown): DashboardSnapshot {
  if (!isDict(value)) throw new ValidationError("snapshot must be an object");
  const session = sanitizeSession(value.session);
  return {
    session,
    orchestrator: sanitizeMainAgent(value.orchestrator),
    artifacts: arrayOf(value.artifacts, MAX_ARTIFACT_LIST, sanitizeArtifact),
  };
}

/** Slice a view of one session's snapshot so the browser never gets artifact bodies inline. */
export function projectArtifacts(snapshot: DashboardSnapshot) {
  return snapshot.artifacts.map(artifact => ({
    id: artifact.id,
    title: artifact.title,
    type: artifact.type,
    version: artifact.version,
    createdBy: artifact.createdBy,
    createdAt: artifact.createdAt,
    updatedAt: artifact.updatedAt,
    tags: artifact.tags,
    ...(artifact.scope === undefined ? {} : { scope: artifact.scope }),
    ...(artifact.childId === undefined ? {} : { childId: artifact.childId }),
  }));
}
