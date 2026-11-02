/**
 * Intent graph: the data model behind the workflow todo tools.
 *
 * Design contract, in one paragraph: a plan is an agent's working memory of
 * intent, not a compliance record. The board (what may be worked on NOW) is a
 * projection; the event log is the truth. Statuses that describe the world
 * (`ready`, `blocked`, `waiting`) are DERIVED from dependencies and live claims,
 * never declared by the model. Completion is checked when the harness can check
 * it, and marked honestly unverified when it cannot.
 *
 * Everything here is pure so the invariants are testable without an agent.
 */

import { createHash } from "node:crypto";

export const STATE_VERSION = 2 as const;

/** Stored statuses. There are deliberately no `blocked`/`waiting` states. */
export type TaskStatus = "open" | "claimed" | "done" | "failed" | "dropped";

/**
 * A scratch plan is turn-local and never persisted or injected; it is the
 * default because most work needs no durable artefact. A committed plan
 * survives the turn, is re-injected once per turn as a single line, and is the
 * only kind that may gate a completion report.
 */
export type Scope = "scratch" | "committed";

export type EvidenceKind = "file" | "cmd" | "test" | "artifact" | "commit" | "url";

/** How far the harness got in confirming an evidence ref. */
export type EvidenceCheck = "verified" | "attested";

export interface Evidence {
  kind: EvidenceKind;
  /** kind=file */
  path?: string;
  line?: number;
  /** kind=cmd */
  cmd?: string;
  exit?: number;
  /** kind=test */
  name?: string;
  pass?: boolean;
  /** kind=artifact */
  id?: string;
  version?: number;
  /** kind=commit */
  sha?: string;
  /** kind=url */
  url?: string;
  check?: EvidenceCheck;
}

export interface Claim {
  owner: string;
  at: number;
  /** Claims are leases: an expired claim returns its task to the ready frontier. */
  expiresAt: number;
}

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  deps: string[];
  /** Exclusive work key, e.g. "file:extensions/todo.ts". Two live claims may not share one. */
  resource?: string;
  claim?: Claim;
  evidence?: Evidence[];
  /** Why it failed or was dropped. Never used for verification. */
  reason?: string;
  /** Free text carried over from the v1 tool or supplied by the model. Never used for verification. */
  note?: string;
  /** v1's "continuous activeText": what the task looks like while it is claimed. Display only. */
  activeText?: string;
  createdAt: number;
  settledAt?: number;
  /** True when at least one evidence ref was confirmed by the harness. */
  verified?: boolean;
}

export interface Plan {
  kind: "intent-plan";
  version: typeof STATE_VERSION;
  id: string;
  /** The request this plan serves, verbatim. Identity for staleness and hashing. */
  goal: string;
  scope: Scope;
  tasks: Task[];
  createdAt: number;
  updatedAt: number;
  supersededAt?: number;
}

// ── Event log ───────────────────────────────────────────────────────────────

export interface PlanEntry {
  v: typeof STATE_VERSION;
  kind: "plan";
  plan: Plan;
  ownerSessionId?: string;
}

export interface TransitionEntry {
  v: typeof STATE_VERSION;
  kind: "transition";
  planId: string;
  taskId: string;
  to: TaskStatus;
  at: number;
  by: string;
  claim?: Claim;
  evidence?: Evidence[];
  reason?: string;
  note?: string;
  verified?: boolean;
  ownerSessionId?: string;
}

export interface SupersedeEntry {
  v: typeof STATE_VERSION;
  kind: "supersede";
  planId: string;
  at: number;
  reason: string;
  ownerSessionId?: string;
}

export type Entry = PlanEntry | TransitionEntry | SupersedeEntry;

// ── Identity ────────────────────────────────────────────────────────────────

const digest = (...parts: string[]): string =>
  createHash("sha256").update(parts.join("\u0000")).digest("hex");

/** Short, stable, content-derived id. Stable across forks: the same work collides by design. */
export const hashId = (prefix: string, ...parts: string[]): string =>
  `${prefix}-${digest(...parts).slice(0, 6)}`;

export const normalizeTitle = (title: string): string =>
  title.trim().replace(/\s+/g, " ").toLowerCase();

export const planIdFor = (goal: string): string => hashId("p", normalizeTitle(goal));

/** Content-derived task id: identical work in the same goal converges instead of duplicating. */
export const taskIdFor = (goal: string, title: string, taken: readonly Task[] = []): string => {
  const base = hashId("t", normalizeTitle(goal), normalizeTitle(title));
  if (!taken.some(task => task.id === base)) return base;
  for (let salt = 2; ; salt++) {
    const candidate = `${base}-${salt}`;
    if (!taken.some(task => task.id === candidate)) return candidate;
  }
};

// ── Derived state: the whole point of the model ─────────────────────────────

export const isSettled = (task: Task): boolean =>
  task.status === "done" || task.status === "failed" || task.status === "dropped";

export const isLiveClaim = (task: Task, now: number): boolean =>
  task.status === "claimed" && !!task.claim && task.claim.expiresAt > now;

/** A claim that outlived its lease. The task is not lost; it is simply claimable again. */
export const isExpiredClaim = (task: Task, now: number): boolean =>
  task.status === "claimed" && !isLiveClaim(task, now);

const taskById = (plan: Plan, id: string): Task | undefined => plan.tasks.find(task => task.id === id);

export const depsSatisfied = (plan: Plan, task: Task): boolean =>
  task.deps.every(dep => taskById(plan, dep)?.status === "done");

/** Another task holds this task's exclusive resource. */
export const resourceBusy = (plan: Plan, task: Task, now: number): boolean =>
  !!task.resource &&
  plan.tasks.some(other => other.id !== task.id && other.resource === task.resource && isLiveClaim(other, now));

/** Claimable now: open, unblocked, unclaimed, resource free. */
export const isReady = (plan: Plan, task: Task, now: number): boolean =>
  task.status === "open" && depsSatisfied(plan, task) && !resourceBusy(plan, task, now);

/** Waiting on dependencies. Computed, never declared. */
export const isBlocked = (plan: Plan, task: Task): boolean =>
  task.status === "open" && !depsSatisfied(plan, task);

export const frontier = (plan: Plan, now: number): Task[] =>
  plan.tasks.filter(task => isReady(plan, task, now));

export const unsettled = (plan: Plan): Task[] => plan.tasks.filter(task => !isSettled(task));

export const isFinished = (plan: Plan): boolean => unsettled(plan).length === 0;

export const isLive = (plan: Plan): boolean => !plan.supersededAt;

export const doneCount = (plan: Plan): number => plan.tasks.filter(task => task.status === "done").length;

/** Compact, human-first label. Unverified completion is visible, never hidden. */
export const taskLabel = (task: Task): string => {
  if (task.status === "done" && task.verified === false) return "done (unverified)";
  return task.status;
};

// ── Evidence ────────────────────────────────────────────────────────────────

/** What the harness can actually check. Anything absent here is attested only. */
export interface EvidenceResolver {
  fileExists?(path: string): boolean;
  artifactExists?(id: string): boolean;
}

const attested = (evidence: Evidence): Evidence => ({ ...evidence, check: "attested" });
const verified = (evidence: Evidence): Evidence => ({ ...evidence, check: "verified" });

/**
 * Confirm what can be confirmed.
 *
 * `file` is checked on disk and `test` is checked by its recorded result. `cmd`,
 * `artifact`, `commit` and `url` can only be attested here: re-running a command
 * or resolving a commit is the caller's job, so claiming "verified" for them
 * would be the same dishonesty this model exists to remove.
 */
export function checkEvidence(evidence: Evidence, resolver: EvidenceResolver = {}): Evidence {
  if (evidence.kind === "file" && evidence.path) {
    const exists = resolver.fileExists ? resolver.fileExists(evidence.path) : false;
    return exists ? verified(evidence) : attested(evidence);
  }
  if (evidence.kind === "test" && evidence.pass === true) return verified(evidence);
  if (evidence.kind === "artifact" && evidence.id) {
    const exists = resolver.artifactExists ? resolver.artifactExists(evidence.id) : false;
    return exists ? verified(evidence) : attested(evidence);
  }
  return attested(evidence);
}

export const anyVerified = (evidence: readonly Evidence[] | undefined): boolean =>
  (evidence ?? []).some(item => item.check === "verified");

/** A non-empty, structurally valid ref. Empty objects and bare kinds are not evidence. */
export function isValidEvidence(evidence: Evidence): boolean {
  switch (evidence.kind) {
    case "file": return typeof evidence.path === "string" && evidence.path.trim().length > 0;
    case "cmd": return typeof evidence.cmd === "string" && evidence.cmd.trim().length > 0;
    case "test": return typeof evidence.name === "string" && evidence.name.trim().length > 0;
    case "artifact": return typeof evidence.id === "string" && evidence.id.trim().length > 0;
    case "commit": return typeof evidence.sha === "string" && evidence.sha.trim().length > 0;
    case "url": return typeof evidence.url === "string" && /^https?:\/\//.test(evidence.url);
    default: return false;
  }
}

// ── Transitions ─────────────────────────────────────────────────────────────

export interface TransitionRequest {
  taskId: string;
  to: TaskStatus;
  by: string;
  at?: number;
  ttlMs?: number;
  evidence?: Evidence[];
  reason?: string;
  note?: string;
}

export const DEFAULT_CLAIM_TTL_MS = 30 * 60 * 1000;

/**
 * Validate a transition against the graph.
 *
 * Returns the reason it is refused, or undefined when allowed. Kept here so the
 * tool surface and the tests share one definition of correctness.
 */
export function refusal(plan: Plan, request: TransitionRequest, _resolver: EvidenceResolver = {}): string | undefined {
  const now = request.at ?? Date.now();
  if (!isLive(plan)) return "This plan was superseded. Declare a new plan with todo_plan.";
  const task = taskById(plan, request.taskId);
  if (!task) {
    const ids = plan.tasks.map(candidate => candidate.id).join(", ");
    return `No task ${request.taskId}. Known ids: ${ids || "none"}.`;
  }

  if (request.to === "claimed") {
    if (task.status === "claimed") return isLiveClaim(task, now) ? "Already claimed. Renew is not needed; settle it instead." : undefined;
    if (isSettled(task)) return `Task is ${task.status}; reopen it with todo_plan first.`;
    if (!depsSatisfied(plan, task)) {
      const missing = task.deps.filter(dep => taskById(plan, dep)?.status !== "done").join(", ");
      return `Blocked by ${missing}. Work the frontier from todo_next.`;
    }
    if (resourceBusy(plan, task, now)) {
      const holder = plan.tasks.find(other => other.id !== task.id && other.resource === task.resource && isLiveClaim(other, now));
      return `${task.resource} is claimed by ${holder?.claim?.owner ?? "another task"} (${holder?.id}).`;
    }
    return undefined;
  }

  if (request.to === "done") {
    if (task.status === "done") return "Already done.";
    if (isSettled(task)) return `Task is ${task.status}; reopen it with todo_plan first.`;
    const evidence = (request.evidence ?? []).filter(isValidEvidence);
    if (!evidence.length) {
      return "done requires at least one evidence ref the harness can check: {kind:\"file\",path} or {kind:\"test\",name,pass} are verified; cmd/artifact/commit/url are attested.";
    }
    return undefined;
  }

  if (request.to === "failed" || request.to === "dropped") {
    if (isSettled(task) && task.status !== request.to) return `Task is already ${task.status}.`;
    return undefined;
  }

  return `Unsupported transition to ${String(request.to)}. Use claimed, done, failed, or dropped.`;
}

/** Apply a transition. Callers must have run `refusal` first. */
export function applyTransition(
  plan: Plan,
  request: TransitionRequest,
  resolver: EvidenceResolver = {},
): { plan: Plan; entry: TransitionEntry } {
  const at = request.at ?? Date.now();
  const evidence = request.evidence?.filter(isValidEvidence).map(item => checkEvidence(item, resolver));
  const tasks = plan.tasks.map(task => {
    if (task.id !== request.taskId) return task;
    if (request.to === "claimed") {
      return {
        ...task,
        status: "claimed" as TaskStatus,
        claim: { owner: request.by, at, expiresAt: at + (request.ttlMs ?? DEFAULT_CLAIM_TTL_MS) },
        ...(request.note ? { note: request.note } : {}),
      };
    }
    const settled: Task = {
      ...task,
      status: request.to,
      settledAt: at,
      ...(evidence?.length ? { evidence, verified: anyVerified(evidence) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.note ? { note: request.note } : {}),
    };
    delete settled.claim;
    return settled;
  });
  const next: Plan = { ...plan, tasks, updatedAt: at };
  return {
    plan: next,
    entry: {
      v: STATE_VERSION, kind: "transition", planId: plan.id, taskId: request.taskId,
      to: request.to, at, by: request.by,
      ...(request.to === "claimed"
        ? { claim: { owner: request.by, at, expiresAt: at + (request.ttlMs ?? DEFAULT_CLAIM_TTL_MS) } }
        : {}),
      ...(evidence?.length ? { evidence, verified: anyVerified(evidence) } : {}),
      ...(request.reason ? { reason: request.reason } : {}),
      ...(request.note ? { note: request.note } : {}),
    },
  };
}

// ── Replay ──────────────────────────────────────────────────────────────────

/**
 * Rebuild the board from the log.
 *
 * The last `plan` entry wins; transitions after it are applied in order. A
 * superseded plan stays readable (history) but is never resumed.
 */
export function replay(entries: readonly Entry[]): Plan | undefined {
  let plan: Plan | undefined;
  let supersededAt: number | undefined;
  for (const entry of entries) {
    if (entry.kind === "plan") {
      plan = structuredClone(entry.plan);
      supersededAt = plan.supersededAt;
      continue;
    }
    if (!plan || entry.planId !== plan.id) continue;
    if (entry.kind === "supersede") { supersededAt = entry.at; continue; }
    const tasks = plan.tasks.map(task => {
      if (task.id !== entry.taskId) return task;
      if (entry.to === "claimed") {
        return {
          ...task, status: "claimed" as TaskStatus,
          claim: entry.claim ?? { owner: entry.by, at: entry.at, expiresAt: entry.at + DEFAULT_CLAIM_TTL_MS },
        };
      }
      const settled: Task = {
        ...task, status: entry.to, settledAt: entry.at,
        ...(entry.evidence?.length ? { evidence: entry.evidence, verified: entry.verified ?? anyVerified(entry.evidence) } : {}),
        ...(entry.reason ? { reason: entry.reason } : {}),
        ...(entry.note ? { note: entry.note } : {}),
      };
      delete settled.claim;
      return settled;
    });
    plan = { ...plan, tasks, updatedAt: entry.at };
  }
  if (plan && supersededAt !== undefined) plan = { ...plan, supersededAt };
  return plan;
}

// ── Rendering helpers ───────────────────────────────────────────────────────

/** Compact projection for the sidebar and the tool result. */
export function boardSummary(plan: Plan, now: number) {
  return {
    id: plan.id,
    scope: plan.scope,
    goal: plan.goal.length > 120 ? `${plan.goal.slice(0, 117)}...` : plan.goal,
    done: doneCount(plan),
    total: plan.tasks.length,
    ready: frontier(plan, now).map(task => task.id),
    ...(plan.supersededAt ? { superseded: true } : {}),
  };
}

/**
 * The single line injected into context, or undefined when there is nothing
 * worth saying. A scratch plan never injects: it lives and dies inside the turn
 * that created it, which is why the common request pays nothing.
 */
export function injectionLine(plan: Plan | undefined, now: number): string | undefined {
  if (!plan || plan.scope !== "committed" || plan.supersededAt) return undefined;
  const open = unsettled(plan);
  if (!open.length) return undefined;
  const ready = frontier(plan, now).map(task => task.id);
  const claimed = open.filter(task => isLiveClaim(task, now));
  const waiting = open.filter(task => isBlocked(plan, task));
  const parts = [
    `plan ${plan.id} · ${doneCount(plan)}/${plan.tasks.length} done`,
    ready.length ? `ready ${ready.join(", ")}` : "",
    claimed.length ? `claimed ${claimed.map(task => `${task.id}→${task.claim?.owner}`).join(", ")}` : "",
    waiting.length ? `blocked ${waiting.length}` : "",
  ].filter(Boolean);
  return parts.join(" · ");
}

/** One line per task, for `todo_next` and the dialog. */
export const renderTask = (plan: Plan, task: Task, now: number): string => {
  const flags: string[] = [];
  if (isReady(plan, task, now)) flags.push("ready");
  if (isBlocked(plan, task)) flags.push(`blocked by ${task.deps.filter(dep => taskById(plan, dep)?.status !== "done").join(",")}`);
  if (isLiveClaim(task, now)) flags.push(`claimed by ${task.claim?.owner}`);
  if (isExpiredClaim(task, now)) flags.push("claim expired");
  if (task.resource) flags.push(task.resource);
  if (task.status === "done" && task.verified === false) flags.push("unverified");
  // v1's activeText described the work while it was claimed, so only surface it then.
  const title = task.status === "claimed" && task.activeText ? `${task.title} → ${task.activeText}` : task.title;
  return `${task.id} [${taskLabel(task)}] ${title}${flags.length ? ` — ${flags.join("; ")}` : ""}`;
};

// ── Construction ────────────────────────────────────────────────────────────

export interface TaskSeed {
  title: string;
  deps?: string[];
  resource?: string;
  note?: string;
  activeText?: string;
}

/**
 * Build a plan. Titles are the identity, so re-declaring the same title keeps
 * its task id and its settled status instead of minting a duplicate.
 */
export function buildPlan(input: {
  goal: string;
  scope: Scope;
  seeds: readonly TaskSeed[];
  at?: number;
  previous?: Plan;
}): Plan {
  const at = input.at ?? Date.now();
  const goal = input.goal.trim();
  const previous = input.previous;
  const carried = new Map<string, Task>();
  // Carry settled history forward only when the goal is unchanged: the ids are
  // goal-scoped, so a different request must not inherit a finished task.
  if (previous && normalizeTitle(previous.goal) === normalizeTitle(goal)) {
    for (const task of previous.tasks) carried.set(normalizeTitle(task.title), task);
  }
  const tasks: Task[] = [];
  for (const seed of input.seeds) {
    const prior = carried.get(normalizeTitle(seed.title));
    const id = prior?.id ?? taskIdFor(goal, seed.title, tasks);
    const keep = prior && isSettled(prior) ? prior : undefined;
    tasks.push(keep ?? {
      id, title: seed.title.trim(), status: "open",
      deps: [...(seed.deps ?? [])],
      ...(seed.resource ? { resource: seed.resource } : {}),
      ...(seed.note ? { note: seed.note } : {}),
      ...(seed.activeText ? { activeText: seed.activeText } : {}),
      createdAt: at,
    });
  }
  // Resolve deps that were written as titles or short prefixes, so a model that
  // names prerequisites instead of ids still gets a valid graph.
  const byId = new Map(tasks.map(task => [task.id, task]));
  for (const task of tasks) {
    task.deps = task.deps.map(dep => {
      if (byId.has(dep)) return dep;
      const title = normalizeTitle(dep);
      const match = tasks.find(candidate =>
        normalizeTitle(candidate.title) === title || candidate.id.endsWith(dep.replace(/^t-/, "")) || candidate.title.toLowerCase().startsWith(title));
      return match?.id ?? dep;
    });
  }
  return {
    kind: "intent-plan", version: STATE_VERSION, id: planIdFor(goal),
    goal, scope: input.scope, tasks, createdAt: at, updatedAt: at,
  };
}

// ── Legacy v1 migration ─────────────────────────────────────────────────────

/**
 * Read a v1 `workflow_todo` state blob. Kept so an in-flight session is not
 * silently discarded on upgrade. Text evidence is preserved as `note` and the
 * task is marked unverified, which is exactly what a prose claim deserves.
 */
export function fromLegacyState(state: any, owner: string, at = Date.now()): Plan | undefined {
  if (!state || !Array.isArray(state.items) || !state.items.length) return undefined;
  const goal = String(state.reason ?? "Migrated workflow plan");
  const statusMap: Record<string, TaskStatus> = {
    pending: "open", in_progress: "claimed", done: "done",
    blocked: "open", waiting: "open", cancelled: "dropped",
  };
  const tasks: Task[] = state.items.map((item: any) => {
    const status = statusMap[String(item.status)] ?? "open";
    const note = typeof item.note === "string" && item.note.trim() ? item.note.trim() : undefined;
    return {
      id: hashId("t", normalizeTitle(goal), normalizeTitle(String(item.text ?? ""))),
      title: String(item.text ?? "untitled").trim(),
      status,
      deps: [],
      ...(status === "claimed" ? { claim: { owner, at, expiresAt: at + DEFAULT_CLAIM_TTL_MS } } : {}),
      ...(status === "done" && note ? { verificationNote: note } : {}),
      ...(note ? { note } : {}),
      ...(typeof item.activeText === "string" && item.activeText.trim() ? { activeText: item.activeText.trim() } : {}),
      ...(status === "done" ? { verified: false, settledAt: at } : {}),
      createdAt: at,
    } as Task;
  });
  return {
    kind: "intent-plan", version: STATE_VERSION, id: hashId("p", normalizeTitle(goal)),
    goal, scope: "committed", tasks, createdAt: at, updatedAt: at,
  };
}
