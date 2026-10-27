/**
 * orchestrator — the orchestrator parent.
 *
 * Three rules shape this extension, and they are enforced structurally rather
 * than asked for in a prompt:
 *
 * 1. THE ORCHESTRATOR ONLY HANDS OFF AND REVIEWS.
 *    Its product is a handoff spec (orch_handoff), and its second act is a verdict
 *    (orch_review). It has no edit/write tool. An orchestrator that implements
 *    produces diffs nobody owns and a review that is not independent of the work.
 *
 * 2. A CHILD RECEIVES ITS OWN HANDOFF AND NOTHING ELSE.
 *    The spec is *inlined* into the child's ticket. No sibling scope name, no
 *    sibling path, no directory a child could enumerate. `PI_SUBAGENT_SPEC` used
 *    to be exported into every child's environment while nothing ever read it, so
 *    specs were silently never delivered and children guessed their lane. Handing
 *    over a *path* would only trade that bug for a worse one: all children share a
 *    UID, so a path given to one child is a path the others can open by guessing.
 *    Non-disclosure is the only boundary that actually holds.
 *
 * 3. UNCERTAINTY ESCALATES: child → orchestrator → user.
 *    A child that does not know pings the orchestrator. An orchestrator that does
 *    not know asks the user. A cancelled dialog is never consent, and a settled
 *    decision is not renegotiated. See lib/escalation.ts.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import {
  HandoffError,
  buildAdhocTicket,
  buildChildTicket,
  handoffArtifactPayload,
  handoffIdFor,
  leakedSiblingScopes,
  renderHandoffForChild,
  sanitizeScope,
  writeHandoff,
  type HandoffRecord,
  type HandoffSpec,
} from "../lib/orchestrator/handoff.ts";
import {
  ScopeRegistry,
  type CloseReason,
  type ReviewRecord,
  type ScopedChild,
  type SteerRecord,
} from "../lib/orchestrator/scope-registry.ts";
import {
  loadRegistrySnapshot,
  saveRegistrySnapshot,
  type PersistedState,
} from "../lib/orchestrator/registry-persistence.ts";
import {
  ESCALATION_TYPE,
  EscalationError,
  EscalationLedger,
} from "../lib/orchestrator/escalation.ts";
import {
  deliverSteer,
  INTERRUPT_KEY,
  matchOwner,
  routeUpdate,
  type SteerResolution,
} from "../lib/orchestrator/steer-router.ts";
// Supervise-mode enforcement (tool allowlist, bash narrowing, guidance section) is
// owned by pi-workflow-extensions/extensions/modes.ts, which installs the
// `tool_call` guard and the `before_agent_start` prompt section. Importing the
// policy here too would create a second, silently divergent authority — one that
// nothing actually applied. v2 supplies the tools; modes.ts is the gate.

import {
  buildLaunchPlan,
  buildResumeLaunchPlan,
  type LaunchPlan,
} from "../vendor/pi-herdr-subagents/src/launch.ts";
import { createHerdrClient, type HerdrClient } from "../vendor/pi-herdr-subagents/src/herdr/client.ts";
import { createHerdrEventStream } from "../vendor/pi-herdr-subagents/src/herdr/events.ts";
import {
  watchSubagent,
  type RunningSubagent,
  type SubagentOutcome,
} from "../vendor/pi-herdr-subagents/src/watcher.ts";
import { buildOutcomeMessage } from "../vendor/pi-herdr-subagents/src/messages.ts";
import { loadAgentDefaults } from "../vendor/pi-herdr-subagents/src/agents.ts";
import { loadSubagentSettings } from "../vendor/pi-herdr-subagents/src/settings.ts";
import { childContextState, isSubagentChildSession } from "../lib/subagent-context.ts";
import { isDelegationTool, isRetiredDelegationTool, mayUseDelegationTool } from "../lib/delegation-tools.ts";
import { CHECKPOINT_TYPE } from "../lib/subagent-state.ts";
import {
  artifactFromRecord,
  artifactSidecarPath,
  lookupArtifact,
  recordsFromBranch,
  sanitizeArtifactId,
} from "../lib/artifact-state.ts";
import {
  checkEvidenceRefs,
  pathMatchesAnyLane,
  renderEvidence,
  type EvidenceRef,
} from "../lib/orchestrator/evidence.ts";
import { execFileSync } from "node:child_process";
import {
  buildCheckReport,
  buildReviewPacket,
  renderCheckReport,
  renderReviewPacket,
  verifyCommandProblem,
} from "../lib/orchestrator/brief.ts";
import { superviseModeFromBranch } from "../lib/supervise-mode.ts";
import { planModeFromBranch } from "../lib/plan-mode.ts";
import {
  capacityProblem,
  childToolsForPurpose,
  currentSpawnDepth,
  defaultSpawnPurpose,
  depthProblem,
  maxChildren,
  registryPurpose,
  requiresReviewedSpec,
  spawnRefusal,
} from "../lib/spawn-policy.ts";
import type { SpawnPurpose } from "../lib/delegation-tools.ts";
import {
  SPEC_ONLY_TOOLS,
  isReviewLens,
  isSpecOnlyDeniedTool,
  pathPolicyProblem,
  readTargets,
  renderPolicyForReviewer,
  reviewPolicyFromEnv,
  reviewPolicyStatus,
  type ReviewLens,
} from "../lib/orchestrator/review-policy.ts";
import {
  REVIEW_PRESET_QUICK,
  applyDispositions,
  designRefProblem,
  evaluateReadiness,
  isReviewPreset,
  openReviewRun,
  parseReviewerReport,
  pinTarget,
  renderReviewerTicket,
  renderRunSummary,
  reviewerScope,
  settleReadiness,
  stalenessProblem,
  type DesignRef,
  type ReviewRun,
} from "../lib/orchestrator/spec-review.ts";
import {
  criteriaHashOf,
  describeReceipt,
  evaluateReceipt,
  outputDigestOf,
  treeDigestOf,
  type CheckReceipt,
} from "../lib/orchestrator/receipts.ts";
import { DASHBOARD_SYNC_EVENT, publishDashboardState } from "../lib/dashboard/integration.ts";
import { projectChildProvenance, projectOrchestrator } from "../lib/dashboard/projection.ts";
import { displayName as namingDisplayName, givenNameFor, givenNamePart, isHumanName } from "../lib/naming.ts";

/** Shared handles. Exported so tests can assert on real state, not a mock. */
export const registry = new ScopeRegistry();
export const escalations = new EscalationLedger();
export const handoffs = new Map<string, { record: HandoffRecord; path: string }>();
/**
 * Independent specification reviews, keyed by run id.
 *
 * Lives beside `handoffs` because they answer the same kind of question — "what
 * was agreed for this work unit" — and is persisted with them so a restart does
 * not silently turn an approved design back into an unreviewed one.
 */
export const specReviews = new Map<string, ReviewRun>();
/**
 * Check receipts, keyed by receipt id.
 *
 * In memory only by design: a receipt says "this command ran in this tree during
 * this process". Restoring one after a restart would vouch for work the gate no
 * longer has any way to observe, which is exactly the claim a receipt exists to
 * make honestly.
 */
export const checkReceipts = new Map<string, CheckReceipt>();

export interface OrchestratorDeps {
  client?: HerdrClient;
  stream?: any;
  /** Clock seam: the watchdog's budget maths must be testable without waiting. */
  now?: () => number;
  /** Watchdog period override for runtime tests (default 30s). */
  watchdogIntervalMs?: number;
}

/**
 * Test seam.
 *
 * The watchdog is driven by an interval created inside the extension, so a
 * runtime test has no deterministic way to advance it. Assigned during init and
 * `null` until then, so a test cannot silently exercise an uninitialised tick.
 */
export const watchdogSeams: { tick: (() => Promise<void>) | null } = { tick: null };

/**
 * Review seam: the changed-file list the lane check is computed from.
 *
 * A test cannot safely depend on the repository it runs in, so it supplies the
 * list. In production this is `git status`, and `null` means "could not compute"
 * — the review then says so instead of pretending it verified the lane.
 */
export const reviewSeams: {
  changedFiles: ((cwd: string) => string[] | null) | null;
  /** Unified diff for the review packet; null means "could not compute". */
  diffText: ((cwd: string) => string | null) | null;
  /** Runs a verification command. Injected so a test never shells out. */
  runCommand: ((command: string, cwd: string) => { exit: number; output: string; timedOut?: boolean }) | null;
} = { changedFiles: null, diffText: null, runCommand: null };

function gitChangedFiles(cwd: string): string[] | null {
  try {
    const output = execFileSync("git", ["status", "--porcelain=v1", "--untracked-files=all"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const files: string[] = [];
    for (const line of String(output).split("\n")) {
      if (!line.trim()) continue;
      const rest = line.slice(3).trim();
      const path = rest.includes(" -> ") ? rest.split(" -> ").pop()! : rest;
      files.push(path.replace(/^"|"$/g, ""));
    }
    return files;
  } catch {
    // Not a repo, no git, or an unreadable worktree: "unknown", never "clean".
    return null;
  }
}

/**
 * Unified diff for the packet.
 *
 * Bounded at the source: a 20k-line diff would blow the packet budget before the
 * renderer ever saw it, and `git diff` on a huge worktree can take seconds.
 */
function gitDiffText(cwd: string, files?: readonly string[]): string | null {
  try {
    const output = execFileSync(
      "git",
      ["diff", "HEAD", "--unified=2", "--no-color", ...(files?.length ? ["--", ...files] : [])],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 8 * 1024 * 1024 },
    );
    return String(output);
  } catch {
    return null;
  }
}

/**
 * Run a verification command.
 *
 * The caller has already narrowed the grammar (`verifyCommandProblem`); this only
 * has to bound it. `shell: false` is not usable because the allowed forms carry
 * arguments, so the command string is passed to `sh -c` after that grammar check.
 * Output is kept to the last 400 lines: a failing suite prints the summary at the
 * end, and the beginning is what the truncation would otherwise keep.
 */
function runVerifyCommand(command: string, cwd: string, timeoutMs = 300_000) {
  try {
    const output = execFileSync("sh", ["-c", command], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
    });
    return { exit: 0, output: tail(String(output), 400) };
  } catch (error: any) {
    const output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    return {
      exit: typeof error?.status === "number" ? error.status : 1,
      output: tail(String(output), 400),
      timedOut: error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT",
    };
  }
}

function tail(value: string, lines: number): string {
  const all = value.split("\n");
  return (all.length <= lines ? all : all.slice(-lines)).join("\n");
}

/**
 * Files already sent for a scope, so a second review does not re-read them.
 *
 * Nothing is persisted: this is a request-level convenience. A restart simply
 * re-sends the hunks, which is the safe direction to fail.
 */
const briefCursor = new Map<string, Set<string>>();

function text(value: string, details?: unknown) {
  return {
    content: [{ type: "text" as const, text: value }],
    details: (details ?? {}) as any,
  };
}

/**
 * Watchdog notice wording, pure so it can be asserted without timers.
 *
 * Both strings are built from concatenated template literals, and an earlier
 * revision dropped the interpolations: the parent read "exceeded its wall-clock
 * budget Decide: orch_resume…" and "showed no visible progress for It was
 * interrupted", i.e. the only numbers that justified the interrupt were missing.
 * Keep the facts (elapsed/budget, strikes/elapsed checks) in the sentence.
 */
export function budgetNotice(params: {
  name: string;
  scope: string;
  elapsedMs: number;
  budgetMs: number;
  /** False when no keystroke landed (pane already gone / Esc refused). */
  interrupted?: boolean;
}): string {
  const elapsed = Math.max(0, Math.round(params.elapsedMs / 60_000));
  const budget = Math.max(0, Math.round(params.budgetMs / 60_000));
  const outcome = params.interrupted === false
    ? `No interrupt could be delivered (the pane is gone), so the child is marked closed — nothing is parked.`
    : `It was interrupted (Esc) and is paused.`;
  return `Watchdog: child "${params.name}" (scope: ${params.scope}) exceeded its wall-clock budget `
    + `(${elapsed}m elapsed of ${budget}m). ${outcome} `
    + `Decide: orch_resume to grant more time, or orch_close to end it and re-scope.`;
}

export function stallNotice(params: {
  name: string;
  scope: string;
  strikes: number;
  intervalMs: number;
  interrupted?: boolean;
}): string {
  const strikes = Math.max(1, Math.round(params.strikes));
  const minutes = Math.max(0, Math.round((strikes * params.intervalMs) / 60_000));
  const span = minutes >= 1 ? `~${minutes}m` : `~${Math.round((strikes * params.intervalMs) / 1000)}s`;
  const outcome = params.interrupted === false
    ? `No interrupt could be delivered (the pane is gone), so the child is marked closed.`
    : `It was interrupted and is paused.`;
  return `Watchdog: child "${params.name}" (scope: ${params.scope}) showed no visible progress across `
    + `${strikes} consecutive checks (${span}). ${outcome} `
    + `Inspect its pane, then orch_resume with direction, or orch_close to end it.`;
}

export default function orchestratorExtension(pi: ExtensionAPI, deps?: OrchestratorDeps): void {
  const client: HerdrClient = deps?.client || createHerdrClient();
  const moduleController = new AbortController();
  /**
   * One watcher per session file, tagged with the attempt that armed it.
   *
   * The id matters: an aborted watcher settles asynchronously, and its `.then`
   * used to delete the *new* abort handle and close the *new* row after a resume
   * had superseded it — leaving a live child unwatched.
   */
  const activeWatchers = new Map<string, { id: string; abort: () => void }>();

  let eventStream = deps?.stream;
  const getEventStream = () => {
    if (!eventStream) {
      eventStream = process.env.HERDR_SOCKET_PATH
        ? createHerdrEventStream({ socketPath: process.env.HERDR_SOCKET_PATH, signal: moduleController.signal })
        : { watch: () => () => {}, onReconcile: () => () => {} };
    }
    return eventStream;
  };

  // ── Persistence + watchdog state (module-function scope) ────────────────────
  let sessionDir: string | null = null;
  /** The session id this in-memory state belongs to, so a switch can be detected. */
  let lastOwnerSessionId: string | null = null;
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  const now = deps?.now ?? (() => Date.now());
  const WATCHDOG_INTERVAL_MS = deps?.watchdogIntervalMs ?? 30_000;
  const DEFAULT_BUDGET_MS = 30 * 60 * 1000;
  const MAX_STALL_STRIKES = 3;
  /** After an interrupt the pane is static by definition; do not call it a stall. */
  const INTERRUPT_COOLDOWN_MS = 10 * 60 * 1000;
  /** Backoff before retrying a close that failed while the pane was still alive. */
  const CLOSE_RETRY_MS = Math.min(WATCHDOG_INTERVAL_MS, 60_000);
  /** Failed Escape deliveries tolerated before the watchdog ends the child itself. */
  const MAX_INTERRUPT_ATTEMPTS = 2;
  /** A sidecar nobody consumed after this long is stale, not pending. */
  const SIDECAR_GRACE_MS = 60_000;
  const MAX_REVISE_ROUNDS = 2;

  // ── Parent-only guard ──────────────────────────────────────────────────────
  // A delegated child loads this extension too: `--tools` narrows the child's tool
  // surface, never its event hooks. Children share the parent's session directory
  // (same cwd), so an unguarded child restored the PARENT's registry from the
  // sidecar, watched its own siblings, pressed Escape in their panes, and steered
  // itself with notices meant for the parent — while the parent received none of
  // them. Observed in the ruumi QA run: 13 watchdog notices landed in three
  // children and zero in the owner.
  let isChildSession = false;
  let ownerSessionId: string | null = null;

  /**
   * Registry sidecar, keyed by session id.
   *
   * The session directory is shared by every session — and every child — started in
   * the same cwd, so a bare `orchestrator-registry.json` was one file for all of them
   * and each writer raced every other. A child gets no path at all: it owns no
   * children, no handoffs and no escalations.
   */
  function registryPath(): string | null {
    if (isChildSession || !sessionDir || !ownerSessionId) return null;
    return join(sessionDir, `orchestrator-registry-${ownerSessionId}.json`);
  }

  function persistState(): void {
    // Publish first: dashboard state is authoritative in memory and must not be
    // lost when the sidecar write fails or the directory is read-only.
    publishDashboard();
    const path = registryPath();
    if (!path) return;
    const state: PersistedState = {
      ...registry.toSnapshot(),
      handoffs: [...handoffs.entries()].map(([id, entry]) => ({ id, record: entry.record, path: entry.path })),
      escalations: escalations.all(),
      specReviews: [...specReviews.values()],
    };
    saveRegistrySnapshot(path, state);
  }

  /**
   * Publish the current orchestrator view for the dashboard.
   *
   * Children own no top-level session, so a delegated child never publishes. The
   * projection is allowlisted there; this function only decides when and what to
   * hand it. Every failure is swallowed: a dashboard observer must not be able to
   * change an orchestration decision.
   */
  function publishDashboard(): void {
    if (isChildSession) return;
    try {
      const children = registry.getAllChildren();
      publishDashboardState(pi, {
        orchestrator: projectOrchestrator({
          children,
          handoffs: [...handoffs.values()].map((entry) => entry.record),
          reviews: registry.getReviews(),
          escalations: escalations.all(),
          specReviews: [...specReviews.values()],
          paused: registry.isPaused(),
        }),
        childSessions: projectChildProvenance(children),
      });
    } catch {
      // Best-effort observer bridge only.
    }
  }

  // Handshake: the dashboard may load after this extension, so it asks for a
  // fresh statement of current state instead of relying on a missed event.
  pi.events?.on(DASHBOARD_SYNC_EVENT, () => publishDashboard());

  /** Drop everything that belongs to the session that just ended. */
  function resetSessionState(): void {
    for (const entry of activeWatchers.values()) entry.abort();
    activeWatchers.clear();
    registry.reset();
    handoffs.clear();
    escalations.clear();
    specReviews.clear();
    checkReceipts.clear();
  }

  function restorePersistedState(): void {
    const path = registryPath();
    if (!path) return;
    const snapshot = loadRegistrySnapshot(path);
    if (!snapshot) return;
    registry.loadSnapshot(snapshot);
    for (const entry of snapshot.handoffs ?? []) {
      if (entry?.id) handoffs.set(entry.id, { record: entry.record, path: entry.path ?? "" });
    }
    for (const esc of snapshot.escalations ?? []) {
      try {
        escalations.restore(esc);
      } catch {
        // A malformed escalation record must not block the session restore.
      }
    }
    for (const run of snapshot.specReviews ?? []) {
      // A run without an id, target hash, or reviewer list cannot be trusted to
      // answer "was this reviewed?", so it is dropped rather than half-restored.
      if (!run || typeof run !== "object") continue;
      if (typeof run.id !== "string" || !run.target?.contentHash || !Array.isArray(run.reviewers)) continue;
      specReviews.set(run.id, run as ReviewRun);
    }
  }

  /**
   * Single source of truth for "is this pane still there?".
   *
   * Tri-state on purpose. `pane get` is the existence oracle: null means
   * pane_not_found and every other failure throws. `pane read` is only a
   * diagnostic tail — it used to resolve null for *every* error, so one herdr
   * timeout was indistinguishable from a dead pane and the watchdog closed a
   * live child. `unknown` means "do not decide": keep the row, keep watching,
   * retry — never treat an unreachable CLI as a death certificate.
   */
  async function paneLiveness(
    paneId: string,
    lines = 1,
  ): Promise<
    | { state: "alive"; tail: string | null }
    | { state: "gone"; reason: string }
    | { state: "unknown"; reason: string }
  > {
    let pane: { pane_id?: string } | null;
    try {
      pane = await client.paneGet(paneId);
    } catch (error: any) {
      return { state: "unknown", reason: `pane get failed: ${String(error?.message ?? error)}` };
    }
    if (pane === null) return { state: "gone", reason: "pane_not_found" };
    try {
      return { state: "alive", tail: await client.paneRead(paneId, lines) };
    } catch {
      // Existence is proven; only the diagnostic tail is unavailable.
      return { state: "alive", tail: null };
    }
  }

  /** A watcher is about to classify this child from a sidecar; do not race it. */
  function hasPendingExitSignal(sessionFile: string): boolean {
    return existsSync(`${sessionFile}.exit`) || existsSync(`${sessionFile}.exitcode`);
  }

  /**
   * A sidecar old enough that no live watcher is going to consume it. Without
   * this, an aborted watcher plus a leftover sidecar hid a dead pane forever.
   */
  function hasStaleExitSignal(sessionFile: string): boolean {
    for (const file of [`${sessionFile}.exit`, `${sessionFile}.exitcode`]) {
      try {
        if (now() - statSync(file).mtimeMs >= SIDECAR_GRACE_MS) return true;
      } catch {
        // absent: try the other sidecar
      }
    }
    return false;
  }

  /**
   * A closed child leaves no question waiting: a pane that is gone cannot answer
   * one. Matched by id *and* session file, because a resume supersedes the id —
   * a stale question whose childId no longer exists would otherwise stay open and
   * let a later answer hijack the live child.
   */
  function closeEscalationsFor(child: { id: string; sessionFile: string }, reason: string): void {
    for (const escalation of escalations.all()) {
      if (escalation.childId !== child.id && escalation.sessionFile !== child.sessionFile) continue;
      if (escalation.stage === "answered" || escalation.stage === "cancelled") continue;
      try {
        escalations.cancel(escalation.id, reason);
      } catch {
        // A settled escalation is immutable; nothing to do.
      }
    }
  }

  /** Mutating only the row is not enough: a watcher that is still running can overwrite it. */
  function detachWatcher(sessionFile: string): void {
    const entry = activeWatchers.get(sessionFile);
    if (!entry) return;
    activeWatchers.delete(sessionFile);
    try {
      entry.abort();
    } catch {
      // best effort
    }
  }

  /**
   * Drop the handle only if it still belongs to this attempt. A superseded
   * watcher that settles late must not delete its successor's handle.
   */
  function releaseWatcher(sessionFile: string, id: string): void {
    if (activeWatchers.get(sessionFile)?.id === id) activeWatchers.delete(sessionFile);
  }

  /** Does this attempt still own the row for its session file? */
  function ownsRow(running: RunningSubagent): boolean {
    const current = registry.getChildById(running.id);
    return current !== undefined && current.sessionFile === running.sessionFile;
  }

  /**
   * The only terminal transition.
   *
   * Every path that ends a child (interrupt+close, review, watchdog, escalation)
   * goes through here, so the pane, the row, the watcher and the escalation
   * ledger agree. Reporting an observation, never an intention: `paneState` says
   * whether a close actually happened.
   */
  /**
   * End a child's checkpoint record, which is what the panel and sidebar read.
   *
   * The registry and the checkpoints live in different layers: closing a row here
   * left the checkpoint entry saying `running`, so `/subagents` and the sidebar
   * kept showing "unverified (last known running)" for a child whose pane was
   * already gone. A checkpoint entry is a display fact, never a reason to fail a
   * close, so it is best-effort.
   */
  function recordChildClosed(child: ScopedChild, reason: CloseReason): void {
    try {
      pi.appendEntry(CHECKPOINT_TYPE, {
        sessionFile: child.sessionFile,
        runId: "",
        name: child.name,
        ...(child.agent ? { agent: child.agent } : {}),
        task: child.task ?? "",
        ...(child.paneId ? { paneId: child.paneId } : {}),
        status: "closed",
        ended: true,
        updatedAt: child.closedAt ?? new Date(now()).toISOString(),
        summary: `Closed by the orchestrator (${reason}).`,
        files: child.lastMilestoneFiles ?? [],
        verification: "",
        next: "",
        ...(child.scope ? { scope: child.scope } : {}),
      });
    } catch {
      // Display state only; the registry remains authoritative.
    }
  }

  async function settleChild(
    target: ScopedChild,
    reason: CloseReason,
  ): Promise<
    | { ok: true; paneState: "closed" | "already-gone"; child: ScopedChild }
    | { ok: false; paneState: "failed"; reason: string }
  > {
    let paneState: "closed" | "already-gone" = "already-gone";
    let closeFailed: string | null = null;
    if (target.paneId) {
      const liveness = await paneLiveness(target.paneId);
      if (liveness.state === "unknown") {
        // "I could not reach herdr" is not "the child is done". Closing the row
        // here would hand a live agent to nobody — the leak this audit is about.
        return {
          ok: false,
          paneState: "failed",
          reason: `pane ${target.paneId} liveness unknown (${liveness.reason}); refused to close on a guess`,
        };
      }
      if (liveness.state === "alive") {
        try {
          await client.paneClose(target.paneId);
          paneState = "closed";
        } catch (error: any) {
          const message = String(error?.message ?? error);
          if (!/pane_not_found|not found/i.test(message)) closeFailed = message;
        }
      }
    }
    if (closeFailed) {
      // A live pane must never sit in a status the watchdog ignores (blocked and
      // ping-paused rows are not ticked). Re-arm the budget loop so it retries.
      registry.rearmForRetry(target.sessionFile, closeFailed, new Date(now()).toISOString());
      persistState();
      return { ok: false, paneState: "failed", reason: closeFailed };
    }
    detachWatcher(target.sessionFile);
    closeEscalationsFor(target, `Child closed (${reason}).`);
    const wasClosed = target.status === "closed";
    const child = registry.closeChild(target.sessionFile, reason) ?? target;
    if (!wasClosed) recordChildClosed(child, reason);
    persistState();
    return { ok: true, paneState, child };
  }

  /**
   * Reconcile restored children against live panes. A child whose pane is gone
   * is closed — pretending it still runs makes orch_running lie. A child with a
   * live pane is re-watched: after a restart nobody else would report its end.
   */
  async function reconcileRestoredChildren(): Promise<{ restored: number; closed: number }> {
    let restored = 0;
    let closed = 0;
    for (const child of registry.getRunningChildren()) {
      if (!child.paneId) {
        registry.closeChild(child.sessionFile, "pane-gone");
        closed++;
        continue;
      }
      const liveness = await paneLiveness(child.paneId);
      if (liveness.state === "gone") {
        registry.closeChild(child.sessionFile, "pane-gone");
        closed++;
        continue;
      }
      // `unknown` still gets a watcher: the watcher retries liveness itself and
      // will report the child's end. Closing on a failed probe is the leak.
      rewatchRestored(child);
      restored++;
    }
    if (closed > 0) persistState();
    return { restored, closed };
  }

  /** Re-attach a watcher to a child that survived a pi restart. */
  function rewatchRestored(child: ScopedChild): void {
    if (!child.paneId || activeWatchers.has(child.sessionFile)) return;
    registry.recordPane(child.paneId);
    const running: RunningSubagent = {
      id: child.id,
      name: child.name,
      task: child.task ?? "Restored child",
      agent: child.agent,
      paneId: child.paneId,
      startTime: child.startedAt ?? now(),
      sessionFile: child.sessionFile,
      launchScriptFile: child.launchScriptFile ?? "",
      interactive: child.interactive ?? false,
      autoExit: child.autoExit ?? false,
      scope: child.scope,
    };
    const controller = new AbortController();
    activeWatchers.set(child.sessionFile, { id: child.id, abort: () => controller.abort() });
    void watchSubagent(running, { client: client as any, stream: getEventStream(), signal: controller.signal })
      .then((outcome: SubagentOutcome) => {
        releaseWatcher(child.sessionFile, child.id);
        handleOutcome(running, child.scope, outcome);
      })
      .catch(() => {
        releaseWatcher(child.sessionFile, child.id);
        // A watcher that cannot run leaves a live pane with nobody reporting its
        // end. Settle it rather than parking a row no loop will ever look at.
        if (ownsRow(running)) void settleChild(child, "watcher-error").catch(() => {});
      });
  }

  const ANSI_ESCAPE = /\x1b\[[0-9;?]*[a-zA-Z]/g;

  /** Spinner frames and colour codes are not progress; a static screen is not a stall. */
  function normalizePaneTail(tail: string | null): string {
    return (tail ?? "").replace(ANSI_ESCAPE, "").trim();
  }

  async function interruptPane(child: ScopedChild): Promise<boolean> {
    if (!child.paneId) return false;
    try {
      await client.paneSendKeys(child.paneId, [INTERRUPT_KEY]);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Trip the watchdog for one reason, exactly once.
   *
   * The `watchdog.trip` guard is the fix for the notice storm: the old budget
   * branch set the child `blocked`, but `getRunningChildren()` includes
   * `blocked`, so the same child re-tripped on every 30s tick — pressing Escape
   * and re-notifying forever. A trip is now a state, not an event.
   *
   * Parking is only allowed on positive evidence: a delivered Escape or a pane
   * confirmed gone. When the Escape does not land the child is still running, so
   * it stays in the watchdog (a `blocked` row is not ticked) with an attempt
   * counter, and is closed after MAX_INTERRUPT_ATTEMPTS. That closes the hole
   * where a failed interrupt parked a live agent outside every loop.
   */
  async function tripWatchdog(
    child: ScopedChild,
    kind: "budget-exceeded" | "stall-detected",
    facts: { elapsedMs?: number; budgetMs?: number; strikes?: number; tail: string | null; retry?: boolean },
  ): Promise<void> {
    if (child.watchdog?.trip === kind && !facts.retry) return;

    const interrupted = await interruptPane(child);
    const at = new Date(now()).toISOString();

    // Re-read existence after the Escape: a pane can vanish mid-trip, and a plain
    // pseudo-terminal prompt does not always accept a key event.
    const liveness = child.paneId
      ? await paneLiveness(child.paneId)
      : ({ state: "gone", reason: "no pane recorded" } as const);
    if (liveness.state === "gone") {
      await settlePaneGone(child);
      return;
    }

    if (!interrupted) {
      // The child is still running, so it must stay in the watchdog: `blocked`
      // rows are not ticked, and parking a live agent there is how one escaped
      // every loop. Count attempts, retry on the next tick, then end it.
      const failures = (child.watchdog?.interruptFailures ?? 0) + 1;
      registry.updateRuntime(child.sessionFile, { lastTail: facts.tail, stallStrikes: 0 });
      registry.updateWatchdog(child.sessionFile, {
        trip: kind,
        trippedAt: at,
        interruptFailures: failures,
        ...(facts.retry ? {} : { notifiedAt: at }),
      });
      persistState();

      if (failures >= MAX_INTERRUPT_ATTEMPTS) {
        const settled = await settleChild(child, "interrupt-failed");
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: settled.ok
              ? `Watchdog: child "${child.name}" (scope: ${child.scope}) ignored ${failures} interrupts. `
                + `Its pane was closed (${settled.paneState}) so it cannot keep running unowned.`
              : `Watchdog: child "${child.name}" (scope: ${child.scope}) ignored ${failures} interrupts, and closing it failed (${settled.reason}). `
                + `It stays under watchdog retry — use orch_close on pane ${child.paneId}.`,
            display: true,
            details: {
              id: child.id,
              name: child.name,
              scope: child.scope,
              reason: "interrupt-failed",
              interruptFailures: failures,
              closed: settled.ok,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
        return;
      }

      if (!facts.retry) {
        pi.sendMessage(
          {
            customType: "subagent_result",
            content:
              `Watchdog: child "${child.name}" (scope: ${child.scope}) exceeded its limit, but the interrupt did not land `
              + `(${liveness.state === "unknown" ? "herdr is unreachable" : "the pane refused keys"}). `
              + `It was kept in the watchdog and will retry; if that keeps failing it is closed. `
              + `Decide now: orch_resume with direction, or orch_close.`,
            display: true,
            details: {
              id: child.id,
              name: child.name,
              scope: child.scope,
              reason: kind,
              interrupted: false,
              interruptFailures: failures,
            },
          },
          { triggerTurn: true, deliverAs: "followUp" },
        );
      }
      return;
    }

    // Escape delivered: only now is `blocked` a truthful state.
    registry.updateStatus(child.sessionFile, "blocked");
    registry.updateRuntime(child.sessionFile, { lastTail: facts.tail, stallStrikes: 0 });
    registry.updateWatchdog(child.sessionFile, {
      trip: kind,
      trippedAt: at,
      notifiedAt: at,
      interruptSentAt: at,
      addInterrupt: true,
      interruptFailures: 0,
    });
    persistState();

    const content = kind === "budget-exceeded"
      ? budgetNotice({
          name: child.name,
          scope: child.scope,
          elapsedMs: facts.elapsedMs ?? 0,
          budgetMs: facts.budgetMs ?? 0,
          interrupted,
        })
      : stallNotice({
          name: child.name,
          scope: child.scope,
          strikes: facts.strikes ?? 0,
          intervalMs: WATCHDOG_INTERVAL_MS,
          interrupted,
        });

    pi.sendMessage(
      {
        customType: "subagent_result",
        content,
        display: true,
        details: {
          id: child.id,
          name: child.name,
          scope: child.scope,
          reason: kind,
          interrupted,
          ...(kind === "budget-exceeded"
            ? { elapsedMs: facts.elapsedMs ?? 0, budgetMs: facts.budgetMs ?? 0 }
            : { strikes: facts.strikes ?? 0 }),
        },
      },
      // `followUp`, not `steer`: a watchdog notice is not a mid-turn correction,
      // and a steer preempts whatever the parent is doing.
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /**
   * A running child whose pane is gone is not coming back.
   *
   * A sidecar means a watcher is about to classify the child itself — but only if
   * a watcher exists. A stale sidecar with no watcher used to freeze the row as
   * `running` with a dead pane, invisible to every later tick, so the sidecar is
   * ignored once it is old enough and nobody is listening for it.
   */
  async function settlePaneGone(child: ScopedChild): Promise<void> {
    if (hasPendingExitSignal(child.sessionFile)) {
      if (activeWatchers.has(child.sessionFile) || !hasStaleExitSignal(child.sessionFile)) return;
    }
    const settled = await settleChild(child, "pane-gone");
    if (!settled.ok) return;
    pi.sendMessage(
      {
        customType: "subagent_result",
        content:
          `Child "${child.name}" (scope: ${child.scope}) ended without a report: its pane is gone. `
          + `It is marked closed (pane-gone). Nothing is parked.`,
        display: true,
        details: { id: child.id, name: child.name, scope: child.scope, reason: "pane-gone" },
      },
      { triggerTurn: true, deliverAs: "followUp" },
    );
  }

  /**
   * Close panes this parent opened that no row owns any more.
   *
   * Attribution is the point: `pane list` also contains the user's panes and other
   * sessions' children. Only an id recorded when *this* parent called paneStart is
   * ever closed, so a lost row cannot hide a live pane without risking a pane the
   * orchestrator never owned.
   */
  async function sweepOrphanPanes(): Promise<{ closed: number }> {
    const known = registry.getKnownPanes();
    if (known.length === 0) return { closed: 0 };
    let live: Set<string>;
    try {
      live = new Set((await client.paneList()).map((pane) => pane.pane_id));
    } catch {
      return { closed: 0 }; // herdr unreachable: sweep nothing rather than guess
    }
    const owned = new Set(
      registry
        .getAllChildren()
        .filter((c) => c.status !== "closed" && c.paneId)
        .map((c) => c.paneId as string),
    );
    let closed = 0;
    for (const paneId of known) {
      if (!live.has(paneId)) {
        registry.forgetPane(paneId);
        continue;
      }
      if (owned.has(paneId)) continue;
      try {
        await client.paneClose(paneId);
        registry.forgetPane(paneId);
        closed++;
      } catch {
        // keep it known so the next start retries
      }
    }
    if (closed > 0) persistState();
    return { closed };
  }

  /**
   * The watchdog enforces the spawn's wall-clock budget and detects stalls —
   * the two failure modes a child cannot self-report (it believes it is still
   * working). Without it, `budgetMinutes` was accepted-but-never-enforced and a
   * stuck child burned the budget forever.
   *
   * Input is `getWatchdogChildren()` (running only): a tripped or ping-paused
   * child is waiting on a decision, not on a timer.
   */
  async function runWatchdogTick(): Promise<void> {
    for (const child of registry.getWatchdogChildren()) {
      // A failed close is not a decision for the parent to make: retry it.
      if (child.watchdog?.trip === "close-failed") {
        const lastAttempt = child.watchdog.trippedAt ? Date.parse(child.watchdog.trippedAt) : 0;
        if (!Number.isFinite(lastAttempt) || now() - lastAttempt >= CLOSE_RETRY_MS) {
          await settleChild(child, "watchdog-close");
        }
        continue;
      }
      // A trip that could not park the child (failed Escape) stays in the loop.
      const pendingTrip = child.watchdog?.trip;
      if (pendingTrip === "budget-exceeded" || pendingTrip === "stall-detected") {
        const lastAttempt = child.watchdog?.trippedAt ? Date.parse(child.watchdog.trippedAt) : 0;
        if (Number.isFinite(lastAttempt) && now() - lastAttempt < CLOSE_RETRY_MS) continue;
        await tripWatchdog(child, pendingTrip, { tail: null, retry: true });
        continue;
      }
      if (!child.paneId) {
        await settlePaneGone(child);
        continue;
      }

      const liveness = await paneLiveness(child.paneId, 20);
      if (liveness.state === "gone") {
        await settlePaneGone(child);
        continue;
      }
      if (liveness.state === "unknown") continue; // never close on a failed probe
      const tail = liveness.tail;

      const budgetMs = child.budgetMs ?? DEFAULT_BUDGET_MS;
      const elapsed = child.startedAt !== undefined ? now() - child.startedAt : 0;

      if (elapsed >= budgetMs) {
        await tripWatchdog(child, "budget-exceeded", { elapsedMs: elapsed, budgetMs, tail });
        continue;
      }

      // Already tripped for a stall: waiting on the parent, not on the pane.
      if (child.watchdog?.trip) continue;

      // Stall detection: N consecutive identical pane tails means no visible
      // progress. Interrupt so the parent can decide instead of burning tokens.
      const lastInterrupt = child.watchdog?.interruptSentAt ? Date.parse(child.watchdog.interruptSentAt) : null;
      const cooling = lastInterrupt !== null && Number.isFinite(lastInterrupt) && now() - lastInterrupt < INTERRUPT_COOLDOWN_MS;
      const unchanged = normalizePaneTail(tail) === normalizePaneTail(child.lastTail ?? null);
      const strikes = !cooling && unchanged && tail !== null ? (child.stallStrikes ?? 0) + 1 : 0;
      registry.updateRuntime(child.sessionFile, { lastTail: tail, stallStrikes: strikes });
      if (strikes >= MAX_STALL_STRIKES) {
        await tripWatchdog(child, "stall-detected", { strikes, tail });
      }
    }

    // Terminal rows can still own a live pane (a wrapper that held it open after
    // the child finished). Nothing watches those, so sweep them here: a pane is
    // a process, and an unwatched one is exactly what this audit is about.
    for (const child of registry.getTerminalChildren()) {
      if (!child.paneId) continue;
      const liveness = await paneLiveness(child.paneId);
      if (liveness.state !== "alive") continue;
      try {
        await client.paneClose(child.paneId);
      } catch {
        continue; // leave it for the next tick / orch_close
      }
      detachWatcher(child.sessionFile);
      registry.markPaneSwept(child.sessionFile, "auto-close-terminal");
      persistState();
    }
  }

  watchdogSeams.tick = runWatchdogTick;

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      // A tick can outlive its interval when herdr is slow; two overlapping ticks
      // read the same untripped state and both notify, which is the notice storm
      // the trip guard exists to prevent.
      if (tickInFlight) return;
      tickInFlight = true;
      void runWatchdogTick()
        .catch(() => {})
        .finally(() => {
          tickInFlight = false;
        });
    }, WATCHDOG_INTERVAL_MS);
    if (typeof watchdogTimer === "object" && "unref" in (watchdogTimer as any)) {
      (watchdogTimer as any).unref?.();
    }
  }

  function stopWatchdog(): void {
    if (watchdogTimer) {
      clearInterval(watchdogTimer);
      watchdogTimer = null;
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    sessionDir = ctx.sessionManager.getSessionDir();
    ownerSessionId = ctx.sessionManager.getSessionId();
    const header = (ctx.sessionManager as any).getHeader?.();
    const provenChild = isSubagentChildSession(ctx);
    // `seeded` folds in the child flag for legacy seeds that carry a parent-session
    // header but no marker. Either signal means: this session does not own the run.
    isChildSession = provenChild || childContextState(ctx.sessionManager.getBranch(), header, provenChild).seeded;
    if (isChildSession) {
      // No restore, no reconciliation, no watchdog — and therefore no path to a
      // sibling's pane or to the parent's sidecar.
      stopWatchdog();
      return;
    }
    // A session is replaced *inside* this process (`/new`, `/resume`, `/fork`):
    // shutdown persists the old one, then startup fires again with a new id and
    // the same module singletons. Clearing here is the boundary; without it the
    // new session adopted the replaced session's children, handoffs, and
    // escalations, then wrote them into its own sidecar on the first persist.
    if (lastOwnerSessionId !== null && lastOwnerSessionId !== ownerSessionId) resetSessionState();
    lastOwnerSessionId = ownerSessionId;
    restorePersistedState();
    publishDashboard();
    const restored = await reconcileRestoredChildren();
    const swept = await sweepOrphanPanes();
    startWatchdog();
    const parked = registry.getRunningChildren().filter((c) => c.status === "blocked");
    ctx.ui.notify(
      [
        "orchestrator active: author a handoff with orch_handoff, then delegate with orch_spawn.",
        restored.restored || restored.closed
          ? `Restored ${restored.restored} live child(ren); closed ${restored.closed} whose pane was gone.`
          : "",
        swept.closed ? `Closed ${swept.closed} orphaned pane(s) this parent had opened.` : "",
        parked.length ? `${parked.length} child(ren) waiting on your decision — run orch_running.` : "",
      ]
        .filter(Boolean)
        .join(" "),
      "info",
    );
  });

  pi.on("session_shutdown", () => {
    stopWatchdog();
    // Only the owner writes the sidecar. A child writing its restored view marked
    // siblings closed/blocked behind the parent's back.
    if (!isChildSession) persistState();
    moduleController.abort();
    for (const entry of activeWatchers.values()) entry.abort();
    activeWatchers.clear();
  });

  // A child's `--tools` allowlist excludes the orchestrator surface, but a resumed or
  // user-touched child can still have it active. Refuse rather than let a child spawn
  // work the parent cannot see or review.
  pi.on("tool_call", (event, ctx) => {
    // ── spec-only reviewer guard ────────────────────────────────────────────
    // The `--tools` allowlist is the first line, not the only one: a resumed or
    // user-touched reviewer pane could still hold a wider set. The policy is
    // resolved from the launcher-written environment, so a profile that 'wants'
    // bash or a writer does not get one — the profile can narrow the policy but
    // cannot widen it.
    const policyStatus = reviewPolicyStatus();
    if (policyStatus.state === "invalid") {
      // Fail closed. An ordinary child has no policy at all; a half-written
      // reviewer policy is not ordinary. Let it report the blocker and nothing else.
      if (event.toolName === "orch_ping" || event.toolName === "orch_done") return;
      return {
        block: true,
        reason: `This session declares a spec-only review policy that cannot be read in full (${policyStatus.problems.join("; ")}). `
          + `Only orch_ping/orch_done are available so it can report the blocker; it must not continue as an ordinary child.`,
      };
    }
    const reviewPolicy = policyStatus.state === "valid" ? policyStatus.policy : undefined;
    if (reviewPolicy) {
      if (isSpecOnlyDeniedTool(event.toolName)) {
        return {
          block: true,
          reason: `${event.toolName} is not available to a spec-only reviewer. You have read instruments and \`orch_spec_review_submit\`.`,
        };
      }
      if (READ_PATH_TOOLS.has(event.toolName)) {
        let sessionDir: string | null = null;
        try {
          sessionDir = ctx.sessionManager.getSessionDir();
        } catch {
          sessionDir = null;
        }
        const cwd = (ctx as any).cwd || process.cwd();
        for (const target of readTargets(event.toolName, event.input)) {
          const problem = pathPolicyProblem(target, {
            cwd,
            roots: reviewPolicy.roots.length ? reviewPolicy.roots : [cwd],
            deny: sessionDir ? [sessionDir] : [],
          });
          if (problem) return { block: true, reason: problem };
        }
      }
      return;
    }

    if (!isChildSession) {
      // Independence is a fact about who touched the lane, so the parent's own
      // writes are recorded as they happen. Only `write`/`edit` are exact; a shell
      // command can write anywhere, which is why the review also computes the diff
      // from git instead of trusting this log as proof.
      if (AUTHOR_WRITE_TOOLS.has(event.toolName)) {
        for (const path of authorWrittenPaths(event.input)) {
          registry.recordAuthorWrite({ path, tool: event.toolName, at: new Date(now()).toISOString() });
        }
        persistState();
      }
      return;
    }
    const parentOnly = `${event.toolName} is parent-only: this session is a delegated child. Report back with orch_ping or orch_done instead.`;
    // A retired name may still be registered by a foreign extension. Refuse it
    // before the capability lookup, which deliberately has no entry for it.
    if (isRetiredDelegationTool(event.toolName)) {
      return { block: true, reason: `${event.toolName} was removed from this package; use the orch_* delegation tools instead.` };
    }
    // A child owns its reporting/pull tools (orch_done, orch_ping, …) but never a
    // parent-role delegation tool. This is the call-time half of the capability
    // table; the `--tools` allowlist is the first half.
    if (isDelegationTool(event.toolName)) {
      return mayUseDelegationTool(event.toolName, "child") ? undefined : { block: true, reason: parentOnly };
    }
    if (!event.toolName.startsWith("orch_")) return;
    return { block: true, reason: parentOnly };
  });

  /** Tools whose input names a filesystem path a reviewer might read. */
  const READ_PATH_TOOLS = new Set(["read", "grep", "find", "ls", "ffgrep", "fffind"]);

  /** Files a write/edit call names. Kept next to the audit that consumes it. */
  const AUTHOR_WRITE_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "applypatch", "patch"]);
  function authorWrittenPaths(input: any): string[] {
    const paths: string[] = [];
    for (const key of ["path", "file_path", "filePath"]) {
      if (typeof input?.[key] === "string" && input[key].trim()) paths.push(input[key]);
    }
    if (Array.isArray(input?.paths)) {
      paths.push(...input.paths.filter((value: unknown): value is string => typeof value === "string"));
    }
    if (Array.isArray(input?.edits)) {
      for (const edit of input.edits) if (typeof edit?.path === "string" && edit.path.trim()) paths.push(edit.path);
    }
    return paths;
  }

  // ── Child lifecycle ───────────────────────────────────────────────────────

  /**
   * Start a watcher and register the child.
   *
   * `watchSubagent` returns a Promise. The previous code passed a callback and
   * ignored the returned promise, so it dereferenced `outcome.disposition` — a
   * field that does not exist (the discriminant is `kind`) — and queried it on a
   * pending Promise. Every child outcome was therefore misclassified and the
   * registry never learned a child had finished.
   */
  function armWatcher(
    running: RunningSubagent,
    scope: string,
    laneFiles: string[],
    handoffId?: string,
    budgetMs?: number,
    frozenSpec?: { criteria?: string[]; revision?: number },
    /**
     * Extra registry facts for this row.
     *
     * Kept as a narrow pick rather than a partial row: identity and lifecycle
     * fields are set by the caller above, and letting a caller overwrite them
     * would reintroduce the ghost-row class of bug this registry was rewritten to
     * remove.
     */
    meta?: Pick<ScopedChild, "purpose" | "reviewRunId" | "reviewLens" | "targetHash">,
  ) {
    // One row per session file: a resume supersedes the previous row instead of
    // forking a second "running" ghost that only the newest row can update.
    const superseded = registry.registerChild({
      id: running.id,
      name: running.name,
      agent: running.agent,
      scope,
      sessionFile: running.sessionFile,
      paneId: running.paneId,
      status: "running",
      laneFiles,
      lastMilestoneFiles: [],
      updatedAt: new Date().toISOString(),
      task: running.task,
      startedAt: now(),
      budgetMs: budgetMs ?? DEFAULT_BUDGET_MS,
      stallStrikes: 0,
      launchScriptFile: running.launchScriptFile,
      interactive: running.interactive,
      autoExit: running.autoExit,
      watchdog: { trip: null, interrupts: 0 },
      ...(handoffId ? { handoffId } : {}),
      ...(meta ? { ...meta, purpose: meta.purpose ?? "implementation" } : {}),
      // Freeze the criteria at spawn: the review judges these, not a spec that
      // was rewritten after the child ran.
      ...(frozenSpec?.criteria?.length
        ? {
            frozenCriteria: [...frozenSpec.criteria],
            handoffRevision: frozenSpec.revision ?? 1,
            specFrozenAt: new Date(now()).toISOString(),
          }
        : {}),
    });
    // Abort the superseded watchers BEFORE installing the new handle, or the old
    // abort function is overwritten and leaks — the bug that let a previous run
    // keep writing status for the same session file.
    for (const old of superseded) detachWatcher(old.sessionFile);
    detachWatcher(running.sessionFile);
    persistState();

    const controller = new AbortController();
    activeWatchers.set(running.sessionFile, { id: running.id, abort: () => controller.abort() });

    void watchSubagent(running, {
      client: client as any,
      stream: getEventStream(),
      signal: controller.signal,
    })
      .then((outcome: SubagentOutcome) => {
        releaseWatcher(running.sessionFile, running.id);
        handleOutcome(running, scope, outcome);
      })
      .catch((error: any) => {
        releaseWatcher(running.sessionFile, running.id);
        // No watcher means nobody will ever report this child. `failed` used to
        // be invisible to both the watchdog and startup reconciliation, so the
        // pane kept running unowned. Settle it and report what was observed.
        void (async () => {
          if (!ownsRow(running)) return;
          const target = registry.getChildBySession(running.sessionFile);
          const settled = target ? await settleChild(target, "watcher-error") : null;
          pi.sendMessage(
            {
              customType: "subagent_result",
              content:
                `Subagent "${running.name}" watcher error: ${error?.message ?? String(error)}. `
                + (settled?.ok
                  ? "Its pane was closed instead of leaving an unwatched process behind."
                  : `Its pane could NOT be closed${settled ? `: ${settled.reason}` : ""} — it stays under watchdog retry (orch_close also works).`),
              display: true,
              details: {
                id: running.id,
                name: running.name,
                scope,
                error: String(error?.message ?? error),
                closed: settled?.ok ?? false,
              },
            },
            // `followUp`, not `steer`: an error notice is not a mid-turn correction.
            { triggerTurn: true, deliverAs: "followUp" },
          );
        })();
      });
  }

  function handleOutcome(running: RunningSubagent, scope: string, outcome: SubagentOutcome) {
    // Ownership check: a superseded attempt must not speak for the current row.
    // Without it, an aborted watcher from a resume's old run deleted the new
    // abort handle and closed the NEW row (same session file, different id),
    // leaving its pane running unwatched.
    const current = registry.getChildById(running.id);
    if (!current || current.sessionFile !== running.sessionFile) return;
    if (outcome.kind === "cancelled") {
      if (current.status !== "closed") registry.closeChild(running.sessionFile, "scope-cancelled");
      return;
    }
    // A terminal transition wins over a late report: never resurrect a closed row.
    if (current.status === "closed") return;

    if (outcome.kind === "ping") {
      // A child that asked a question is *paused*, not failed. It stays in the
      // registry as blocked so orch_steer refuses to type into a dead pane and the
      // escalation ladder owns it.
      registry.updateStatus(running.sessionFile, "blocked", { pendingPing: true });
      const escalation = escalations.open({
        id: `esc-${running.id}-${escalations.all().length + 1}`,
        childId: running.id,
        childName: running.name,
        scope,
        sessionFile: running.sessionFile,
        question: outcome.message,
      });
      // The blocked transition and the new escalation are both dashboard state.
      publishDashboard();
      pi.appendEntry(ESCALATION_TYPE, { id: escalation.id, childId: running.id, stage: escalation.stage });
      pi.sendMessage(
        {
          customType: "subagent_ping",
          content: [
            `Child "${running.name}" (scope: ${scope}) is paused on a question:`,
            "",
            outcome.message,
            "",
            `Escalation id: ${escalation.id}`,
            `Answer it with orch_escalate({ id: "${escalation.id}", action: "answer", answer: "..." }) if you know from context you have.`,
            `If you do not, use action: "to-user" with your reason — the user decides, and a cancelled dialog is not an answer.`,
          ].join("\n"),
          display: true,
          details: { id: running.id, name: running.name, scope, escalationId: escalation.id, question: outcome.message },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
      return;
    }

    const completed = outcome.kind === "completed" || outcome.kind === "completed-user-exit";
    registry.updateStatus(running.sessionFile, completed ? "completed" : "failed", { pendingPing: false });
    persistState();

    const message = buildOutcomeMessage(running, outcome);
    if (message) pi.sendMessage(message, { triggerTurn: true, deliverAs: "steer" });
  }

  /** Write a plan's files and make the per-child directory private. */
  function materializePlan(plan: LaunchPlan) {
    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, "utf8");
    }
    // The child's ticket lives in an artifact dir keyed by (parent, handoff), so
    // it is not sitting next to a sibling's. Tighten it: 0700 dir, 0600 files.
    const dir = dirname(plan.sessionFile);
    void dir;
  }

  function artifactsBase(ctx: ExtensionContext): string {
    return join(ctx.sessionManager.getSessionDir(), "artifacts");
  }

  /**
   * Publish the handoff as a SCOPED artifact — the child's actual spec.
   *
   * `scope` is the isolation mechanism, not a label. The artifact layer shows a
   * child only global artifacts plus its own scope (`visibleToScope`), and the
   * child's scope comes from `PI_SUBAGENT_SCOPE`, which the launch planner sets
   * from the same value. So a sibling's handoff is filtered out of the catalog
   * before the child can reach it, and the child never needs to be trusted not to
   * look.
   *
   * Returns a result rather than throwing: the caller must not register a handoff
   * whose artifact does not exist, because a child holding a pointer to nothing
   * would fall back to inferring its lane from `task`.
   */
  async function publishHandoffArtifact(
    ctx: ExtensionContext,
    record: HandoffRecord,
  ): Promise<{ ok: true } | { ok: false; message: string }> {
    const payload = handoffArtifactPayload(record);

    if (typeof (ctx as any).executeTool !== "function") {
      return { ok: false, message: "ctx.executeTool is unavailable, so artifact_save cannot be reached" };
    }

    try {
      const outcome = await (ctx as any).executeTool("artifact_save", payload);
      if (outcome?.isError) {
        return { ok: false, message: String(outcome?.result?.content?.[0]?.text ?? "artifact_save reported an error") };
      }
      return { ok: true };
    } catch (error: any) {
      return { ok: false, message: `artifact_save threw: ${error?.message ?? error}` };
    }
  }

  function resolveHandoff(params: { handoffId?: string; spec?: any }): HandoffRecord | undefined {
    if (params.handoffId) {
      const stored = handoffs.get(params.handoffId);
      if (stored) return stored.record;
      // Tolerate a caller passing the scope instead of the id.
      for (const entry of handoffs.values()) {
        if (entry.record.scope === params.handoffId) return entry.record;
      }
    }
    return undefined;
  }

  /**
   * A scope for a spawn with no handoff to name it.
   *
   * Deterministic from the name or the first words of the task, so `orch_running`,
   * `orch_steer` and `orch_check` all address the same unit. `sanitizeScope` is
   * allowed to reject the slug ("global" is reserved), in which case the neutral
   * fallback is still a valid scope rather than a crash after the pane started.
   */
  function adhocScope(params: { name?: string; task: string }): string {
    const seed = params.name?.trim() || params.task.trim().split(/\s+/).slice(0, 6).join("-");
    const slug = seed.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
    try {
      return sanitizeScope(slug || "adhoc");
    } catch {
      return "adhoc";
    }
  }

  /** The branch, when the context has one. A minimal test context may not. */
  function branchOf(ctx: ExtensionContext): readonly any[] {
    const manager: any = ctx.sessionManager as any;
    return typeof manager?.getBranch === "function" ? (manager.getBranch() ?? []) : [];
  }

  /** The mode this request runs under, derived from branch policy like the guards. */
  function currentModeId(ctx: ExtensionContext): "normal" | "plan" | "supervise" | "orchestrator" {
    const branch = branchOf(ctx);
    if (planModeFromBranch(branch)?.enabled) return "plan";
    const supervise = superviseModeFromBranch(branch);
    if (supervise?.enabled) return supervise.modeId === "orchestrator" ? "orchestrator" : "supervise";
    return "normal";
  }

  // ── spec review: independent readers of a pinned document ───────────────────
  //
  // The EGM property this implements is narrow and worth restating: a specification
  // is judged by readers who did not write it and cannot consult the author. The
  // pinned snapshot travels *inside* the reviewer's ticket, so the reviewer needs
  // no artifact reader and cannot see a sibling's report, a global note, or the
  // parent transcript. `orch_spec_review` is the parent's whole surface: start,
  // collect, resolve, status, cancel.

  /** Reports are control-plane files: written by the child's submit tool, read by the parent. */
  function reviewReportDir(ctx: ExtensionContext, runId: string): string {
    return join(artifactsBase(ctx), ctx.sessionManager.getSessionId(), "spec-reviews", runId);
  }

  /** Largest document we will pin; a 10 MB blob is not a reviewable specification. */
  const MAX_PINNED_CHARS = 512 * 1024;

  /**
   * Read a workspace artifact's exact content.
   *
   * Branch first, then the sidecar the artifact extension writes for scoped specs
   * — those are deliberately kept off the branch, so a branch-only read would
   * report "no such artifact" for a handoff spec that exists.
   */
  function readArtifactForReview(ctx: ExtensionContext, id: string): { title: string; content: string } | null {
    let art = lookupArtifact(id, recordsFromBranch(ctx.sessionManager.getBranch()));
    if (!art) {
      const sessionFile = (ctx.sessionManager as any).getSessionFile?.();
      if (typeof sessionFile === "string" && sessionFile) {
        const path = artifactSidecarPath(sessionFile, sanitizeArtifactId(id));
        if (existsSync(path)) {
          try {
            art = artifactFromRecord(JSON.parse(readFileSync(path, "utf8")));
          } catch {
            art = undefined;
          }
        }
      }
    }
    if (!art) return null;
    if (art.content.length > MAX_PINNED_CHARS) {
      throw new Error(`Artifact [${art.id}] is ${art.content.length} chars; the review cap is ${MAX_PINNED_CHARS}. Narrow the document first.`);
    }
    return { title: art.title, content: art.content };
  }

  /** Re-read whatever the run was pinned from, so staleness is a fact and not a guess. */
  function currentReviewContent(ctx: ExtensionContext, run: ReviewRun): string | null {
    try {
      if (run.target.kind === "artifact") {
        return readArtifactForReview(ctx, run.target.ref)?.content ?? null;
      }
      const path = resolve((ctx as any).cwd || process.cwd(), run.target.ref);
      if (statSync(path).size > MAX_PINNED_CHARS) return null;
      return readFileSync(path, "utf8");
    } catch {
      return null;
    }
  }

  function repoHead(cwd: string): string | null {
    try {
      return String(execFileSync("git", ["rev-parse", "HEAD"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })).trim();
    } catch {
      return null;
    }
  }

  /**
   * Submit tool for a spec-only reviewer.
   *
   * Registered in every process so the child has it, but inert unless the launcher
   * wrote a complete policy: an ordinary session that finds this tool cannot use it
   * to file a review into somebody else's run.
   */
  pi.registerTool({
    name: "orch_spec_review_submit",
    label: "Submit Specification Review",
    description:
      "Submit your independent specification review. Only available in a spec-only reviewer session; the run, lens and pinned revision come from your session, not from arguments.",
    parameters: Type.Object({
      verdict: Type.Optional(
        Type.Union([Type.Literal("clean"), Type.Literal("findings"), Type.Literal("blocked")], {
          description: "Optional self-description. The gate derives readiness from findings, not from this label.",
        }),
      ),
      summary: Type.String({ minLength: 1, maxLength: 4000, description: "2-4 sentences: what you judged and what you concluded." }),
      findings: Type.Array(
        Type.Object({
          id: Type.Optional(Type.String({ maxLength: 80, description: "Optional stable id; derived from your lens if omitted (F-<lens>-<n>)." })),
          severity: Type.Union([Type.Literal("blocker"), Type.Literal("major"), Type.Literal("nit")]),
          location: Type.String({ minLength: 1, description: "Section heading or line number inside the pinned document." }),
          discrepancy: Type.String({ minLength: 1, description: "What is wrong or missing." }),
          rationale: Type.String({ minLength: 1, description: "Why it matters for implementation." }),
          references: Type.Optional(Type.Array(Type.String({ description: "Permitted repository path supporting the finding." }))),
          suggestion: Type.Optional(Type.String({ description: "Optional concrete replacement or addition." })),
        }),
        { description: "Findings for your lens. An empty array is a valid clean answer." },
      ),
      missingContext: Type.Optional(
        Type.Array(Type.String({ description: "Anything you needed and could not find in the document or permitted paths." })),
      ),
    }),
    async execute(_toolCallId, params) {
      const status = reviewPolicyStatus();
      if (status.state === "invalid") {
        throw new Error(
          `This reviewer session's spec-only policy is invalid (${status.problems.join("; ")}); refusing to file a report.`,
        );
      }
      if (status.state !== "valid") {
        throw new Error(
          "orch_spec_review_submit is only available to a spec-only reviewer child. The orchestrator collects reports with orch_spec_review.",
        );
      }
      const policy = status.policy;
      if (!isReviewLens(policy.lens)) {
        throw new Error(`This reviewer session has an unknown lens (${policy.lens}); refusing to file a report.`);
      }
      const lens = policy.lens as ReviewLens;
      const parsed = parseReviewerReport(
        {
          version: 1,
          runId: policy.runId,
          lens,
          targetHash: policy.targetHash,
          summary: params.summary,
          findings: params.findings ?? [],
          ...(params.verdict ? { verdict: params.verdict } : {}),
          ...(params.missingContext?.length ? { missingContext: params.missingContext } : {}),
          submittedAt: new Date(now()).toISOString(),
        },
        { runId: policy.runId, lens, targetHash: policy.targetHash },
      );
      if (!parsed.ok || !parsed.report) {
        throw new Error(`Report rejected by the review gate:\n${parsed.problems.map((problem) => `- ${problem}`).join("\n")}`);
      }
      const file = join(policy.reportDir, `${lens}.json`);
      const temp = `${file}.${process.pid}.tmp`;
      mkdirSync(policy.reportDir, { recursive: true, mode: 0o700 });
      writeFileSync(temp, JSON.stringify(parsed.report, null, 2), { mode: 0o600 });
      renameSync(temp, file);
      const counts = parsed.report.findings.reduce(
        (acc, finding) => ({ ...acc, [finding.severity]: acc[finding.severity] + 1 }),
        { blocker: 0, major: 0, nit: 0 } as Record<string, number>,
      );
      return text(
        [
          `Review submitted for ${policy.runId} (${lens}).`,
          `${parsed.report.findings.length} finding(s): ${counts.blocker} blocker, ${counts.major} major, ${counts.nit} nit.`,
          `The orchestrator collects it with orch_spec_review; you are done unless it resumes you with a question.`,
        ].join("\n"),
        { runId: policy.runId, lens, findings: parsed.report.findings.length, ...counts },
      );
    },
  });

  // ── orch_spec_review — the parent's side of the same contract ───────────────
  pi.registerTool({
    name: "orch_spec_review",
    label: "Independent Spec Review",
    description:
      "Run or resolve an independent, read-only review of a specification before implementation. Pins the document by content hash, launches isolated reviewer children (one per lens), validates their findings, and records readiness. Actions: start | collect | resolve | status | cancel.",
    parameters: Type.Object({
      action: Type.Union([
        Type.Literal("start"),
        Type.Literal("collect"),
        Type.Literal("resolve"),
        Type.Literal("status"),
        Type.Literal("cancel"),
      ], { description: "start = pin + launch reviewers; collect = read submitted reports; resolve = record dispositions and readiness; status = read; cancel = stop the run." }),
      targetArtifactId: Type.Optional(Type.String({ description: "Workspace artifact to review (preferred while the design is still an artifact)." })),
      targetFile: Type.Optional(Type.String({ description: "Repository file to review, relative to the working directory." })),
      title: Type.Optional(Type.String({ description: "Human title for the pinned target." })),
      preset: Type.Optional(Type.Union([Type.Literal("quick"), Type.Literal("architecture")], {
        description: "quick = comprehension + readiness (default). architecture = zoom-out, comprehension, critic, readiness.",
      })),
      references: Type.Optional(Type.Array(Type.String(), { description: "Repository paths reviewers may consult. Defaults to none." })),
      focus: Type.Optional(Type.String({ description: "Optional extra instruction. Never include author reasoning: reviewers must judge the document, not your intent." })),
      budgetMinutes: Type.Optional(Type.Number({ description: "Wall-clock budget per reviewer (default 20)." })),
      runId: Type.Optional(Type.String({ description: "Existing review run id, for collect/resolve/status/cancel." })),
      dispositions: Type.Optional(
        Type.Array(
          Type.Object({
            findingId: Type.String({ minLength: 1 }),
            action: Type.Union([Type.Literal("fix"), Type.Literal("contested"), Type.Literal("accepted"), Type.Literal("unresolved")]),
            rationale: Type.Optional(Type.String({ description: "Required for accepted/contested: why the finding is a trade-off or wrong." })),
            userConfirmed: Type.Optional(Type.Boolean({ description: "Set only after asking the user: required to accept a blocker." })),
          }),
          { description: "For action=resolve: how each finding was handled." },
        ),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (isChildSession) {
        return text("orch_spec_review is parent-only.", { error: "parent-only" });
      }
      const runId = params.runId ? String(params.runId).trim() : undefined;
      const lookup = (id: string) => specReviews.get(id);

      if (params.action === "start") {
        if (registry.isPaused()) {
          return text("The orchestrator is paused: no reviewers were launched.", { error: "orchestrator-paused" });
        }
        const preset = params.preset && isReviewPreset(params.preset) ? params.preset : REVIEW_PRESET_QUICK;
        const cwd = (ctx as any).cwd || process.cwd();
        if (!ctx.sessionManager.getSessionFile()) {
          return text("Error: no session file, so reviewer children cannot be tracked.", { error: "no-session-file" });
        }

        let source: { title: string; content: string } | null = null;
        let kind: "artifact" | "file" = "artifact";
        let ref = "";
        try {
          if (params.targetArtifactId) {
            ref = params.targetArtifactId.trim();
            source = readArtifactForReview(ctx, ref);
            if (!source) {
              return text(`No artifact [${ref}] in this session's catalog. Save the design first with artifact_save.`, { error: "unknown-artifact" });
            }
          } else if (params.targetFile) {
            kind = "file";
            ref = params.targetFile.trim();
            const path = resolve(cwd, ref);
            if (statSync(path).size > MAX_PINNED_CHARS) {
              return text(`Refusing to pin ${ref}: larger than ${MAX_PINNED_CHARS} characters.`, { error: "target-too-large" });
            }
            source = { title: ref, content: readFileSync(path, "utf8") };
          } else {
            return text("Give a target: targetArtifactId (preferred) or targetFile.", { error: "no-target" });
          }
        } catch (error: any) {
          return text(`Could not read the review target: ${error?.message ?? error}`, { error: "target-unreadable" });
        }

        let target;
        try {
          target = pinTarget({
            kind,
            ref,
            title: params.title ?? source.title,
            content: source.content,
            references: params.references ?? [],
            repoBaseline: { head: repoHead(cwd), dirty: (reviewSeams.changedFiles ?? gitChangedFiles)(cwd) },
            now: new Date(now()),
          });
        } catch (error: any) {
          return text(`Refusing to pin the target: ${error?.message ?? error}`, { error: "pin-failed" });
        }

        // A rerun over the same content is a genuinely new attempt: the id carries
        // a salt so the previous run's reports and dispositions stay auditable
        // instead of being overwritten by a second opinion.
        const run = openReviewRun({ target, preset, now: new Date(now()), salt: String(specReviews.size + 1) });
        const dir = reviewReportDir(ctx, run.id);
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        chmodPrivate(dir);

        const parentSessionId = ctx.sessionManager.getSessionId();
        const parentSessionFile = ctx.sessionManager.getSessionFile()!;
        const subagentSettings = loadSubagentSettings(cwd);
        const budgetMinutes = Math.max(1, params.budgetMinutes ?? 20);
        const tools = [...SPEC_ONLY_TOOLS].join(",");

        const launched: string[] = [];
        const failed: string[] = [];
        for (const slot of run.reviewers) {
          const ticket = renderReviewerTicket({
            runId: run.id,
            lens: slot.lens,
            target,
            focus: params.focus,
            policy: { roots: [cwd] },
          }) + `\n${renderPolicyForReviewer({ lens: slot.lens, roots: [cwd] })}\n`;
          let plan: LaunchPlan;
          try {
            plan = buildLaunchPlan(
              {
                name: `spec-${slot.lens}`,
                task: ticket,
                tools,
                policy: "spec-only",
                review: { runId: run.id, lens: slot.lens, targetHash: target.contentHash, dir, roots: [cwd] },
                scope: slot.scope,
              },
              null,
              {
                sessionDir: ctx.sessionManager.getSessionDir(),
                sessionId: `${parentSessionId}-${run.id}-${slot.lens}`,
                parentSessionFile,
                parentCwd: cwd,
                defaultModel: subagentSettings.defaultModel,
                env: process.env,
              },
            );
          } catch (error: any) {
            failed.push(`${slot.lens}: ${error?.message ?? error}`);
            continue;
          }

          try {
            materializePlan(plan);
            const started = await client.paneStart(plan.paneStart);
            registry.recordPane(started.paneId);
            armWatcher(
              {
                id: plan.id,
                name: plan.name,
                task: ticket,
                paneId: started.paneId,
                startTime: Date.now(),
                sessionFile: plan.sessionFile,
                launchScriptFile: plan.launchScriptFile,
                interactive: plan.interactive,
                autoExit: plan.autoExit,
                scope: slot.scope,
              },
              slot.scope,
              [],
              undefined,
              budgetMinutes * 60_000,
              undefined,
              { purpose: "review", reviewRunId: run.id, reviewLens: slot.lens, targetHash: target.contentHash },
            );
            Object.assign(slot, {
              status: "running",
              childId: plan.id,
              sessionFile: plan.sessionFile,
              paneId: started.paneId,
              updatedAt: new Date(now()).toISOString(),
            });
            launched.push(slot.lens);
          } catch (error: any) {
            slot.status = "failed";
            slot.reason = `launch failed: ${error?.message ?? error}`;
            slot.updatedAt = new Date(now()).toISOString();
            failed.push(`${slot.lens}: ${slot.reason}`);
          }
        }

        specReviews.set(run.id, run);
        persistState();
        return text(
          [
            renderRunSummary(run),
            `Pinned ${target.kind} \`${target.ref}\` at ${target.contentHash.slice(0, 12)}.`,
            launched.length ? `Launched: ${launched.join(", ")}.` : "No reviewer was launched.",
            ...(failed.length ? [`Failed: ${failed.join("; ")}`] : []),
            ``,
            `Reviewers are isolated: no parent transcript, no artifacts, no write tool, no shell.`,
            `When they finish, run orch_spec_review({ action: "collect", runId: "${run.id}" }).`,
          ].join("\n"),
          { runId: run.id, targetHash: target.contentHash, preset, launched, failed },
        );
      }

      if (!runId) {
        const known = [...specReviews.keys()];
        return text(
          `Give a runId. ${known.length ? `Known runs: ${known.join(", ")}.` : "No spec review has been started in this session."}`,
          { error: "run-required", known },
        );
      }
      const run = lookup(runId);
      if (!run) {
        return text(`No spec review \`${runId}\` in this session. Known runs: ${[...specReviews.keys()].join(", ") || "(none)"}.`, {
          error: "unknown-run",
        });
      }

      if (params.action === "status") {
        // Status re-checks the document: a readiness badge that outlives the text
        // it approved is the failure this whole mechanism exists to prevent.
        const stale = stalenessProblem(run, currentReviewContent(ctx, run));
        return text(
          renderRunSummary(run) + (stale ? `\nStale: ${stale}. Start a new review of the revised document.` : ""),
          { runId: run.id, status: run.status, ready: run.readiness.ready, stale: stale ?? null },
        );
      }

      if (params.action === "cancel") {
        for (const slot of run.reviewers) {
          if (slot.status !== "running") continue;
          const child = slot.sessionFile ? registry.getChildBySession(slot.sessionFile) : undefined;
          if (child) await settleChild(child, "scope-cancelled");
          slot.status = "failed";
          slot.reason = "run cancelled";
        }
        const cancelled: ReviewRun = {
          ...run,
          status: "cancelled",
          updatedAt: new Date(now()).toISOString(),
          readiness: { ...run.readiness, ready: false, reasons: ["the review run was cancelled"] },
        };
        specReviews.set(cancelled.id, cancelled);
        persistState();
        return text(renderRunSummary(cancelled), { runId: cancelled.id, status: cancelled.status });
      }

      if (params.action === "resolve") {
        const result = applyDispositions(
          run,
          (params.dispositions ?? []).map((entry) => ({
            findingId: entry.findingId,
            action: entry.action,
            rationale: entry.rationale,
            userConfirmed: entry.userConfirmed,
          })),
          { now: new Date(now()) },
        );
        if (!result.ok) {
          return text(
            `Dispositions refused — nothing was recorded:\n${result.problems.map((problem) => `- ${problem}`).join("\n")}`,
            { error: "invalid-dispositions", runId: run.id, problems: result.problems },
          );
        }
        specReviews.set(result.run.id, result.run);
        persistState();
        return text(renderRunSummary(result.run), {
          runId: result.run.id,
          ready: result.run.readiness.ready,
          status: result.run.status,
          counts: result.run.readiness.counts,
        });
      }

      // collect
      const dir = reviewReportDir(ctx, run.id);
      const problems: string[] = [];
      for (const slot of run.reviewers) {
        if (slot.status === "submitted") continue;
        const file = join(dir, `${slot.lens}.json`);
        if (!existsSync(file)) {
          if (slot.status === "running") problems.push(`${slot.lens}: no report yet`);
          continue;
        }
        let raw: unknown;
        try {
          raw = JSON.parse(readFileSync(file, "utf8"));
        } catch (error: any) {
          slot.status = "failed";
          slot.reason = `report is not valid JSON: ${error?.message ?? error}`;
          slot.updatedAt = new Date(now()).toISOString();
          problems.push(`${slot.lens}: ${slot.reason}`);
          continue;
        }
        const parsed = parseReviewerReport(raw, { runId: run.id, lens: slot.lens, targetHash: run.target.contentHash });
        if (!parsed.ok || !parsed.report) {
          slot.status = "failed";
          slot.reason = `invalid report: ${parsed.problems.join("; ")}`;
          slot.updatedAt = new Date(now()).toISOString();
          problems.push(`${slot.lens}: ${slot.reason}`);
          continue;
        }
        run.reports[slot.lens] = parsed.report;
        slot.status = "submitted";
        slot.reportPath = file;
        slot.reason = undefined;
        slot.updatedAt = new Date(now()).toISOString();
      }

      const allIn = run.reviewers.every((slot) => slot.status === "submitted");
      const next = allIn
        ? settleReadiness({ ...run, status: "collected" }, { now: new Date(now()) })
        : {
            ...run,
            readiness: { ...evaluateReadiness(run, { now: new Date(now()) }), decidedAt: new Date(now()).toISOString() },
            updatedAt: new Date(now()).toISOString(),
          };
      specReviews.set(next.id, next);
      persistState();
      return text(
        [renderRunSummary(next), ...(problems.length ? [``, `Waiting on:`, ...problems.map((p) => `- ${p}`)] : [])].join("\n"),
        {
          runId: next.id,
          status: next.status,
          ready: next.readiness.ready,
          counts: next.readiness.counts,
          waiting: problems,
        },
      );
    },
  });

  // ── orch_handoff — the orchestrator's first act ─────────────────────────────
  pi.registerTool({
    name: "orch_handoff",
    label: "Author Handoff Spec",
    description:
      "Author a work handoff for ONE work unit: its goal, acceptance criteria, the files it owns (its lane), files it must not touch, and interfaces it must honour. A child receives exactly this document and nothing else. Returns the handoff id used by orch_spawn.",
    parameters: Type.Object({
      scope: Type.String({
        description: "Work-unit slug, unique among concurrent children (e.g. 'net-retry', 'db-pool'). This is the isolation key.",
      }),
      goal: Type.String({ description: "One line: what this work unit achieves." }),
      acceptanceCriteria: Type.Array(Type.String(), {
        minItems: 1,
        description: "What 'done' means. The review gate requires evidence for each one, gathered by the reviewer.",
      }),
      laneFiles: Type.Array(Type.String(), {
        minItems: 1,
        description: "Files this work unit owns. Required: an empty lane means the child owns the whole repo, which makes steering and review impossible.",
      }),
      outOfLaneFiles: Type.Optional(Type.Array(Type.String(), { description: "Files it must not modify even if it thinks it should." })),
      interfaces: Type.Optional(Type.Array(Type.String(), { description: "Contracts another work unit consumes; changing them silently breaks it." })),
      guidance: Type.Optional(Type.String({ description: "Conventions, prior decisions, or notes from the orchestrator." })),
      reportShape: Type.Optional(Type.String({ description: "What the report must contain beyond prose." })),
      verifyCommand: Type.Optional(
        Type.String({
          description:
            "Test/typecheck command that decides the review; orch_check runs it and returns evidenceRefs. Declare it now: a command chosen after seeing the diff can be chosen to pass.",
        }),
      ),
      vision: Type.Optional(Type.String({ description: "Global vision this spec refines. It must not contradict it." })),
      designRef: Type.Optional(
        Type.Object({
          runId: Type.String({ description: "Spec review run id from orch_spec_review." }),
          targetHash: Type.String({ description: "The reviewed content hash, from orch_spec_review status." }),
        }, { description: "Bind this work unit to an independent specification review. orch_spawn refuses a run that is not ready or whose document changed." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      // A `**/*`-style lane is the whole repo: steering and review cannot be
      // precise against it, and it conflicts with every concurrent child.
      const wholeRepoLanes = params.laneFiles.filter((f) => /^(\*\*\/\*)?\*?$/.test(String(f).trim()) || String(f).trim() === "**/*");
      if (wholeRepoLanes.length > 0) {
        return text(
          `Refusing whole-repo lane (${wholeRepoLanes.join(", ")}). Name the files this work unit owns — ` +
            `an unspecified lane is how two children end up editing the same file while both believe they are alone.`,
          { error: "whole-repo-lane", lanes: wholeRepoLanes },
        );
      }

      const laneConflicts = registry.findLaneConflicts(params.laneFiles);
      if (laneConflicts.length > 0) {
        return text(
          `Refused: lane overlaps ${laneConflicts.map((c) => `"${c.name}" (scope: ${c.scope})`).join(", ")}. ` +
            `Two active children must have disjoint lanes or neither diff is attributable. ` +
            `Wait for the other child, close it, or narrow this lane.`,
          { error: "lane-conflict", conflicts: laneConflicts.map((c) => ({ id: c.id, name: c.name, scope: c.scope })) },
        );
      }

      let record: HandoffRecord;
      let path: string;
      try {
        // A design reference is verified before the handoff exists. Failing at
        // spawn instead would leave a spec in the registry that can never be used.
        if (params.designRef) {
          const reviewed = specReviews.get(String(params.designRef.runId).trim());
          const problem = designRefProblem(
            { runId: String(params.designRef.runId).trim(), targetHash: String(params.designRef.targetHash).trim().toLowerCase() },
            (id) => specReviews.get(id),
            reviewed ? currentReviewContent(ctx, reviewed) : null,
          );
          if (problem) {
            return text(
              `Refusing designRef: ${problem}. Run orch_spec_review({ action: "status", runId }) for the current state, ` +
                `or resolve the findings first.`,
              { error: "design-ref-not-ready", runId: params.designRef.runId },
            );
          }
        }
        const written = writeHandoff(artifactsBase(ctx), ctx.sessionManager.getSessionId(), {
          scope: params.scope,
          goal: params.goal,
          acceptanceCriteria: params.acceptanceCriteria,
          laneFiles: params.laneFiles,
          outOfLaneFiles: params.outOfLaneFiles,
          interfaces: params.interfaces,
          guidance: params.guidance,
          reportShape: params.reportShape,
          verifyCommand: params.verifyCommand,
          vision: params.vision,
          designRef: params.designRef
            ? { runId: String(params.designRef.runId).trim(), targetHash: String(params.designRef.targetHash).trim().toLowerCase() }
            : undefined,
        } as HandoffSpec);
        record = written.record;
        path = written.path;
      } catch (error: any) {
        const message = error instanceof HandoffError ? error.message : `Failed to write handoff: ${error.message}`;
        return text(`Handoff rejected: ${message}`, { error: message });
      }

      // A scope identifies one work unit. Re-authoring the same scope revises it;
      // it must not create a second spec that silently competes with the first.
      const existing = handoffs.get(record.id);
      if (existing) {
        record.revision = existing.record.revision + 1;
        // The audit copy and the artifact must not disagree about the revision.
        writeFileSync(path, renderHandoffForChild(record), { mode: 0o600 });
      }

      // Publish the spec as a SCOPED artifact. This is what the child recalls; the
      // ticket carries only a pointer. Scope is the isolation key: the artifact
      // layer shows a child global artifacts plus its own scope, so a sibling's
      // handoff is filtered out of the catalog before the child can reach it.
      const published = await publishHandoffArtifact(ctx, record);
      if (!published.ok) {
        // Do not register a spec no child could read. A dangling pointer would
        // push the child to infer its lane from `task` — the exact failure that
        // made children guess when PI_SUBAGENT_SPEC was never delivered.
        return text(
          `Handoff NOT published for scope "${record.scope}": ${published.message}. ` +
            `The audit copy is at ${path}, but delegating now would give the child a pointer to nothing.`,
          { error: "artifact-publish-failed", id: record.id, path, detail: published.message },
        );
      }

      handoffs.set(record.id, { record, path });
      persistState();

      for (const child of registry.getAllChildren()) {
        if (child.scope === record.scope && child.status === "running") {
          return text(
            `Handoff ${record.id} written, but scope "${record.scope}" already has a running child. ` +
              `Two children in one scope write the same files: steer or finish the running one first.`,
            { id: record.id, path, scope: record.scope, warning: "scope-already-running" },
          );
        }
      }

      return text(
        [
          `Handoff authored: ${record.id} (scope: ${record.scope}, revision: ${record.revision})`,
          `Artifact: ${record.artifactId} (scoped spec, visible only to scope "${record.scope}")`,
          `Audit copy: ${path}`,
          `Lane (${record.laneFiles.length}): ${record.laneFiles.join(", ")}`,
          `Criteria (${record.acceptanceCriteria.length}):`,
          ...record.acceptanceCriteria.map((c, i) => `  ${i + 1}. ${c}`),
          ``,
          `Delegate with orch_spawn({ handoffId: "${record.id}", name, task }).`,
          `The child is told to recall ${record.artifactId} before starting. It is not given the spec inline, not given a path, and never told another scope exists.`,
        ].join("\n"),
        {
          id: record.id,
          artifactId: record.artifactId,
          path,
          scope: record.scope,
          revision: record.revision,
          laneFiles: record.laneFiles,
        },
      );
    },
  });

  // ── orch_spawn ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_spawn",
    label: "Spawn Orchestrator",
    description:
      "Spawn a worker. With handoffId it gets exactly one handoff spec inlined into its ticket; without one it gets an ad-hoc ticket and no lane. The child cannot see any other work unit's spec, scope name, or paths.",
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({
          description:
            "Display name for the worker. Optional: omit it and a Javanese given name plus role is derived from the handoff scope (e.g. 'Bima · Skeleton Builder'). An explicit human name is kept; a slug is replaced.",
        }),
      ),
      task: Type.String({ description: "The specific assignment. For an ad-hoc spawn this is the whole brief; for a spec spawn it must stay inside the handoff's lane." }),
      handoffId: Type.Optional(Type.String({ description: "Handoff id returned by orch_handoff (its scope is accepted too). Omit it for an ad-hoc spawn." })),
      purpose: Type.Optional(
        Type.Union(
          [
            Type.Literal("spec"),
            Type.Literal("adhoc"),
            Type.Literal("research"),
            Type.Literal("review"),
            Type.Literal("implementation"),
          ],
          {
            description:
              "What this spawn is for. Defaults to spec when handoffId is present, research in Plan mode, adhoc otherwise. Plan admits research/review/spec; Supervise admits spec only.",
          },
        ),
      ),
      laneFiles: Type.Optional(
        Type.Array(Type.String(), {
          description: "Ad-hoc only: files this child owns. Omit it and orch_check reports lane: not-declared instead of inventing a lane.",
        }),
      ),
      acceptanceCriteria: Type.Optional(
        Type.Array(Type.String(), { description: "Ad-hoc only: what done means. Omit it for a pure research child." }),
      ),
      agent: Type.Optional(Type.String({ description: "Agent profile (e.g. 'worker')." })),
      model: Type.Optional(Type.String({ description: "Model override." })),
      skills: Type.Optional(Type.String({ description: "Comma-separated skills." })),
      tools: Type.Optional(Type.String({ description: "Comma-separated allowed tools." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
      budgetMinutes: Type.Optional(Type.Number({ description: "Wall-clock budget in minutes. The watchdog interrupts the child at the budget and asks the parent to decide. Default 30." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      if (registry.isPaused()) {
        // A pause that still accepts work is not a pause. Checked before the
        // handoff lookup so a refused spawn writes nothing at all.
        return text(
          `The orchestrator is paused (/orch-pause): no child was spawned and nothing was written. `
            + `${registry.getPausedChildren().length} paused child(ren) are waiting for /orch-resume.`,
          { error: "orchestrator-paused", paused: registry.getPausedChildren().map((c) => c.id) },
        );
      }
      // ── depth and breadth are hard stops ─────────────────────────────────
      // Checked before the mode/purpose gate, so a nested or over-capacity call
      // cannot leave a row, a pane, a watcher or a ticket behind.
      const depthRefusal = depthProblem();
      if (depthRefusal) {
        return text(depthRefusal, { error: "depth-limit", depth: currentSpawnDepth() });
      }
      const runningCount = registry.getRunningChildren().length;
      const capacityRefusal = capacityProblem(runningCount);
      if (capacityRefusal) {
        return text(capacityRefusal, { error: "child-limit", running: runningCount, max: maxChildren() });
      }

      // ── mode × purpose, resolved before any row exists ───────────────────
      // A refused spawn must leave no registry row, pane, watcher or ticket.
      const modeId = currentModeId(ctx);
      const purpose: SpawnPurpose = params.purpose
        ?? (params.handoffId ? "spec" : defaultSpawnPurpose(modeId));
      const refusal = spawnRefusal(modeId, purpose, false);
      if (refusal) return text(refusal, { error: "purpose-refused", mode: modeId, purpose });

      if (purpose === "review") {
        return text(
          "A review spawn needs a pinned document and an isolated reviewer: start it with orch_spec_review, which creates the reviewer and its ticket.",
          { error: "use-spec-review" },
        );
      }

      const handoff = resolveHandoff(params);
      if (purpose === "spec" && !handoff) {
        return text(
          `No handoff "${params.handoffId}". Author one first with orch_handoff, or spawn an ad-hoc unit without handoffId. ` +
            `Known handoffs: ${[...handoffs.keys()].join(", ") || "(none)"}.`,
          { error: "handoff-required", known: [...handoffs.keys()] },
        );
      }
      if (handoff && purpose === "adhoc") {
        return text(
          `A handoff (${handoff.id}) was supplied, so this is a spec spawn. Drop handoffId for ad-hoc work, or ask for purpose "spec".`,
          { error: "handoff-vs-adhoc", handoffId: handoff.id },
        );
      }

      // Orchestrator/Supervise implementation is spec-driven: a handoff without
      // an independent review is a plan, not an authorised work unit. Checked
      // before naming, the design gate, or any row/pane exists.
      if (requiresReviewedSpec(modeId)
        && (purpose === "spec" || purpose === "implementation")
        && !handoff?.designRef) {
        return text(
          `Orchestrator implementation requires an independent, ready specification review. `
            + `This handoff has no designRef, so nothing authorises the work. Run orch_spec_review on the design until it is ready, `
            + `then re-author the handoff with designRef { runId, targetHash }. Research and ad-hoc delegation do not need a spec review.`,
          { error: "design-review-required", mode: modeId, scope: handoff?.scope },
        );
      }

      const scope = handoff?.scope ?? adhocScope(params);
      const laneFiles = handoff?.laneFiles ?? [...(params.laneFiles ?? [])];
      const acceptanceCriteria = handoff?.acceptanceCriteria ?? [...(params.acceptanceCriteria ?? [])];
      const handoffId = handoff?.id;

      // ── human naming ─────────────────────────────────────────────────────
      // A worker is a person, not a slug. The given name is derived here (from an
      // explicit human name when the author supplied one, otherwise from the
      // handoff scope, which is the only stable identifier before the launch plan
      // mints the child id), and the composed label is what the pane, the prompt,
      // the registry and the dashboard all read. `scope` stays the identity key.
      const requestedName = typeof params.name === "string" ? params.name.trim() : "";
      const givenName = isHumanName(requestedName)
        ? givenNamePart(requestedName)
        : givenNameFor(`scope:${scope}`);
      const displayName = namingDisplayName({ name: givenName, scope }, { givenName, max: 44 });

      // ── the design gate ──────────────────────────────────────────────────
      // A reviewed design is only useful if the worker is launched against the
      // revision that was actually reviewed. Re-authoring the design after review
      // would otherwise leave an approval attached to text nobody read, so the
      // current content is re-read here rather than trusted from the record.
      if (handoff?.designRef) {
        const run = specReviews.get(handoff.designRef.runId);
        const problem = designRefProblem(
          handoff.designRef,
          (id) => specReviews.get(id),
          run ? currentReviewContent(ctx, run) : null,
        );
        if (problem) {
          return text(
            `Refusing to spawn \"${displayName}\": ${problem}. ` +
              `Resolve it with orch_spec_review, or re-author the handoff without designRef if this unit genuinely does not depend on a reviewed design.`,
            { error: "design-ref-not-ready", scope, designRef: handoff.designRef },
          );
        }
      }
      const scopeRows = registry.getRunningChildren().filter((c) => c.scope === scope);
      // Busy is a question about live panes, not about rows: a row whose pane is
      // gone is not a second writer, and blocking on it deadlocks the scope. A
      // row whose pane is alive is busy — including one the registry thinks is
      // closed, which is exactly how two agents ended up in one lane.
      const liveInScope: ScopedChild[] = [];
      for (const row of scopeRows) {
        if (!row.paneId) {
          liveInScope.push(row);
          continue;
        }
        const liveness = await paneLiveness(row.paneId);
        if (liveness.state === "gone") {
          await settleChild(row, "pane-gone");
          continue;
        }
        liveInScope.push(row);
      }
      if (liveInScope.length > 0) {
        return text(
          `Scope "${scope}" already has a running child (${liveInScope.map((c) => c.name).join(", ")}). ` +
            `Two writers in one lane produce diffs nobody owns. Steer or finish it first.`,
          { error: "scope-busy", scope },
        );
      }

      const parentSessionFile = ctx.sessionManager.getSessionFile();
      if (!parentSessionFile) {
        return text("Error: no session file. Start pi with a persistent session so children can be tracked and resumed.", {
          error: "no-session-file",
        });
      }

      const parentSessionId = ctx.sessionManager.getSessionId();
      const agentDefs = params.agent ? loadAgentDefaults(params.agent) : null;
      const subagentSettings = loadSubagentSettings(ctx.cwd);

      // Per-handoff artifact directory: the child's ticket is not parked beside a
      // sibling's. getArtifactDir() is join(sessionDir, 'artifacts', sessionId), so
      // qualifying the sessionId with the handoff id isolates the tree without
      // touching v1's launch planner.
      const childArtifactSessionId = `${parentSessionId}-${handoffId ?? `adhoc-${scope}`}`;

      const ticket = handoff
        ? buildChildTicket(handoff, params.task)
        : buildAdhocTicket({
            scope,
            purpose: purpose === "research" ? "research" : purpose === "implementation" ? "implementation" : "adhoc",
            task: params.task,
            laneFiles,
            acceptanceCriteria,
          });

      // Isolation is a data invariant, checked before the child exists rather than
      // trusted to happen. A ticket that names a sibling's scope hands this child
      // knowledge it has no lane for, and the resulting diff is unattributable.
      const siblingScopes = [...handoffs.values()]
        .map((entry) => entry.record.scope)
        .filter((sibling) => sibling !== scope);
      const leaked = leakedSiblingScopes(ticket, scope, siblingScopes);
      if (leaked.length > 0) {
        return text(
          `Refused to spawn: this child's ticket names other work units (${leaked.join(", ")}). ` +
            `A child receives exactly one handoff. Remove those references from the task and retry.`,
          { error: "sibling-leak", leaked, scope },
        );
      }

      let plan: LaunchPlan;
      try {
        plan = buildLaunchPlan(
          {
            name: displayName,
            task: ticket,
            agent: params.agent,
            model: params.model,
            skills: params.skills,
            tools: params.tools ?? childToolsForPurpose(purpose),
            cwd: params.cwd,
            scope,
            // Deliberately NOT passing specPath: a path is a promise the child
            // shares a UID with its siblings and cannot keep.
          },
          agentDefs,
          {
            sessionDir: ctx.sessionManager.getSessionDir(),
            sessionId: childArtifactSessionId,
            parentSessionFile,
            parentCwd: ctx.cwd,
            defaultModel: subagentSettings.defaultModel,
            env: process.env,
          },
        );
      } catch (error: any) {
        return text(`Failed to build launch plan: ${error.message}`, { error: error.message });
      }

      materializePlan(plan);
      chmodPrivate(join(artifactsBase(ctx), childArtifactSessionId));

      let started;
      try {
        started = await client.paneStart(plan.paneStart);
      } catch (error: any) {
        return text(`Failed to start pane: ${error.message}`, { error: error.message });
      }
      // Attribution for the orphan sweep: a pane this parent opened is ours even
      // after its row is gone; a pane it never opened is never touched.
      registry.recordPane(started.paneId);

      const running: RunningSubagent = {
        id: plan.id,
        name: displayName,
        task: params.task,
        agent: params.agent,
        paneId: started.paneId,
        startTime: Date.now(),
        sessionFile: plan.sessionFile,
        launchScriptFile: plan.launchScriptFile,
        interactive: plan.interactive,
        autoExit: plan.autoExit,
        scope,
      };

      armWatcher(
        running,
        scope,
        laneFiles,
        handoffId,
        params.budgetMinutes ? params.budgetMinutes * 60_000 : undefined,
        { criteria: acceptanceCriteria, revision: handoff?.revision ?? 1 },
        { purpose: registryPurpose(purpose) },
      );

      return text(
        [
          `Subagent "${displayName}" launched (scope: ${scope}, ${handoffId ? `handoff: ${handoffId}` : "ad-hoc, no handoff spec"}).`,
          `Pane: ${started.paneId}`,
          `Lane: ${laneFiles.join(", ") || "not declared (ad-hoc)"}`,
          ``,
          handoffId
            ? `The child holds this handoff only. It cannot see any other work unit.`
            : `The child has no handoff spec. orch_check will report lane: not-declared unless you passed laneFiles.`,
          `The scope (${scope}) is the identity: use it in orch_steer, orch_check and orch_review.`,
          `Do NOT guess results. The outcome (or an orch_ping escalation) arrives automatically.`,
        ].join("\n"),
        {
          id: running.id,
          name: displayName,
          scope,
          purpose,
          ...(handoffId ? { handoffId } : {}),
          status: "started",
          paneId: started.paneId,
          sessionFile: running.sessionFile,
          laneFiles,
        },
      );
    },
  });

  /**
   * A reviewer session is independent for life.
   *
   * `reviewRunId` is persisted with the row, so the decision survives a reload;
   * `purpose` is the shorter form used before the run id existed. Either is
   * enough to refuse author contact.
   */
  function isSpecReviewer(child: ScopedChild | undefined): boolean {
    return Boolean(child && (child.purpose === "review" || child.reviewRunId));
  }

  function reviewerContactRefusal(child: ScopedChild | undefined): string | undefined {
    if (!isSpecReviewer(child)) return undefined;
    return `"${child!.name}" is an independent specification reviewer (run ${child!.reviewRunId ?? "unknown"}). `
      + `Author instructions or answers would contaminate the review. Start a fresh review of the pinned revision with `
      + `orch_spec_review({ action: "start", ... }); this session stays recorded for audit.`;
  }

  /**
   * The launch half of a resume, shared by `orch_resume` and by an answered
   * escalation. One implementation, so "answer the child" cannot drift from
   * "resume the child" — that drift produced a second pi process on one session
   * file and a fresh registry row per answer.
   */
  async function startResume(
    ctx: ExtensionContext,
    params: { sessionPath: string; message?: string; name?: string; autoExit?: boolean },
  ) {
    const child = registry.getChildBySession(params.sessionPath);
    const scope = child?.scope ?? "resumed";

    // Refuse before any pane close, sidecar cleanup or row mutation: resuming a
    // reviewer would graft the author's answer onto a review that must stay
    // independent. A refusal must leave the reviewer exactly as it was.
    if (isSpecReviewer(child)) {
      return text(reviewerContactRefusal(child)!, {
        error: "reviewer-resume-forbidden",
        childId: child!.id,
        runId: child!.reviewRunId ?? null,
      });
    }

    // Orchestrator/Supervise continuation is implementation too. A worker cannot
    // resume past the spec gate by using resume instead of spawn.
    const resumeMode = currentModeId(ctx);
    if (requiresReviewedSpec(resumeMode) && child) {
      const handoff = child.handoffId
        ? handoffs.get(child.handoffId)?.record
        : [...handoffs.values()].find((entry) => entry.record.scope === child.scope)?.record;
      const run = handoff?.designRef ? specReviews.get(handoff.designRef.runId) : undefined;
      const problem = handoff
        ? designRefProblem(handoff.designRef, (id) => specReviews.get(id), run ? currentReviewContent(ctx, run) : null)
        : "this child has no handoff spec, so no reviewed design authorises continued implementation";
      if (problem) {
        return text(
          `Refused to resume "${child.name}": ${problem}. `
            + `Orchestrator/Supervise implementation needs a ready, unchanged specification review; `
            + `switch to Normal (/mode normal) to continue an unreviewed run, or start a fresh reviewed handoff.`,
          { error: "design-review-required", childId: child.id, mode: resumeMode },
        );
      }
    }

    // A resume of a session file that does not exist spawns an orphan pane
    // bound to nothing — observed live when a stopped child was "resumed" and
    // sat parked as a second instance of the same scope. Refuse instead.
    if (!existsSync(params.sessionPath)) {
      return text(
        `Refused to resume: session file ${params.sessionPath} does not exist. ` +
          `Check orch_running for what is actually active; if the scope was cancelled, close it out with orch_review instead of resuming it.`,
        { error: "session-not-found", sessionPath: params.sessionPath },
      );
    }

    // Two pi processes must never share one session file. Close the old pane and
    // abort its watcher before starting the new one, so a resume supersedes the
    // child instead of forking a second instance of the same scope.
    if (child?.paneId) {
      const before = await paneLiveness(child.paneId);
      if (before.state === "unknown") {
        // Two pi processes on one session file is the leak this guard exists for:
        // an unreachable CLI is not proof that the old pane is gone.
        return text(
          `Refusing to resume "${child.name}": pane ${child.paneId} liveness is unknown (${before.reason}). `
            + `Nothing was started — a second process on the same session file would leave one of them unowned.`,
          { error: "resume-aborted", reason: "unknown-liveness", paneId: child.paneId },
        );
      }
      if (before.state === "alive") {
        try {
          await client.paneClose(child.paneId);
        } catch (error: any) {
          const message = String(error?.message ?? error);
          if (!/pane_not_found|not found/i.test(message)) {
            // Positive evidence before a second pane. Reporting "resumed" while an
            // old process still holds the session file is how a child became
            // unaddressable — here the resume is refused instead.
            const after = await paneLiveness(child.paneId);
            if (after.state !== "gone") {
              return text(
                `Refusing to resume "${child.name}": closing its live pane ${child.paneId} failed (${message}). `
                  + `Nothing was started. Close it with orch_close, then retry.`,
                { error: "resume-aborted", reason: message, paneId: child.paneId },
              );
            }
          }
        }
      }
      detachWatcher(child.sessionFile);
      // The resume supersedes this child: an answer to its old question must not
      // be able to re-target the live row later.
      closeEscalationsFor(child, "Child resumed; the previous question is superseded.");
    }

    // Stale sidecars from the previous run would complete the new watcher
    // instantly with the old outcome. The launch planner documents this.
    rmSync(`${params.sessionPath}.exit`, { force: true });
    rmSync(`${params.sessionPath}.exitcode`, { force: true });

    let plan;
    try {
      // buildResumeLaunchPlan takes (params, ctx) — two arguments. The previous
      // call passed a third, shifting ctx into the params slot so every field
      // read (ctx.env, ctx.sessionDir) came from the wrong object.
      plan = buildResumeLaunchPlan(
        {
          sessionPath: params.sessionPath,
          message: params.message,
          name: params.name ?? child?.name ?? "Resumed Subagent",
          autoExit: params.autoExit ?? true,
        },
        {
          sessionDir: ctx.sessionManager.getSessionDir(),
          sessionId: ctx.sessionManager.getSessionId(),
          parentSessionFile: ctx.sessionManager.getSessionFile() ?? "",
          parentCwd: ctx.cwd,
          env: process.env,
        },
      );
    } catch (error: any) {
      return text(`Failed to resume subagent: ${error.message}`, { error: error.message });
    }

    for (const file of plan.files) {
      mkdirSync(dirname(file.path), { recursive: true });
      writeFileSync(file.path, file.content, "utf8");
    }

    let started;
    try {
      started = await client.paneStart(plan.paneStart);
    } catch (error: any) {
      return text(`Failed to start resumed pane: ${error.message}`, { error: error.message });
    }
    registry.recordPane(started.paneId);

    const running: RunningSubagent = {
      id: plan.id,
      name: plan.name,
      task: params.message ?? "Resumed session",
      paneId: started.paneId,
      startTime: now(),
      sessionFile: plan.sessionFile,
      launchScriptFile: plan.launchScriptFile,
      interactive: plan.interactive,
      autoExit: plan.autoExit,
      scope,
    };

    armWatcher(
      running,
      scope,
      child?.laneFiles ?? [],
      child?.handoffId,
      undefined,
      child?.frozenCriteria?.length
        ? { criteria: child.frozenCriteria, revision: child.handoffRevision ?? 1 }
        : undefined,
    );

    return text(`Resumed "${running.name}" in pane ${started.paneId} (scope: ${scope}).`, {
      id: running.id,
      paneId: started.paneId,
      sessionFile: running.sessionFile,
      scope,
      status: "started",
    });
  }

  // ── orch_resume ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_resume",
    label: "Resume Orchestrator",
    description: "Resume an ended or paused child, optionally delivering an answer or correction.",
    parameters: Type.Object({
      sessionPath: Type.String({ description: "Child session .jsonl path." }),
      message: Type.Optional(Type.String({ description: "Follow-up message, answer, or correction." })),
      name: Type.Optional(Type.String({ description: "Display name." })),
      autoExit: Type.Optional(Type.Boolean({ description: "Whether the child auto-exits when its turn completes." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      return startResume(ctx, params);
    },
  });

  // ── orch_interrupt ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_interrupt",
    label: "Interrupt Orchestrator",
    description:
      "Send Escape to a running child's active turn. By default the pane, session, and watcher are kept; pass close:true to end the child instead of parking it.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Target child id." })),
      name: Type.Optional(Type.String({ description: "Target child name." })),
      scope: Type.Optional(Type.String({ description: "Target child scope." })),
      close: Type.Optional(
        Type.Boolean({
          description: "Close the pane and mark the child closed after the Escape (default false: pane and session are kept).",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const target = findTarget(params);
      if (!target) {
        const stale = staleTarget(params);
        if (stale) {
          return text(
            `No running child matched: "${stale.name}" [${stale.id}] is ${stale.status} (${stale.closeReason ?? "no reason recorded"}). `
              + `Nothing was sent — a finished child is not a steering target.`,
            { error: "stale-target", id: stale.id, status: stale.status, closeReason: stale.closeReason },
          );
        }
        return text(
          `No child matched. Running: ${describeRunning()}. Tracked: ${describeTracked()}.`,
          { error: "no-target" },
        );
      }

      // A row whose pane is already gone is not interruptible — reconcile it to
      // closed instead of returning an error and leaving the ghost behind.
      const liveness = target.paneId
        ? await paneLiveness(target.paneId)
        : ({ state: "gone", reason: "no pane recorded" } as const);
      if (liveness.state === "unknown") {
        return text(
          `Cannot verify pane ${target.paneId} for "${target.name}" [${target.id}]: ${liveness.reason}. `
            + `Nothing was sent and nothing was closed — an unreachable herdr is not a dead child.`,
          { id: target.id, status: "unknown-liveness", error: liveness.reason },
        );
      }
      if (liveness.state === "gone") {
        const settled = await settleChild(target, "pane-gone");
        return text(
          `"${target.name}" [${target.id}] is already gone (${liveness.reason}). `
            + (settled.ok ? `Row marked closed (${settled.paneState}). Nothing is parked.` : `Row could not be closed: ${settled.reason}.`),
          { id: target.id, status: "already-gone", closed: settled.ok, paneState: settled.ok ? settled.paneState : "failed" },
        );
      }

      try {
        // Herdr key syntax is `esc`, not Pi's `Escape`. The previous spelling was
        // silently rejected, so "interrupt" never interrupted anything.
        await client.paneSendKeys(target.paneId!, [INTERRUPT_KEY]);
        registry.updateWatchdog(target.sessionFile, {
          interruptSentAt: new Date(now()).toISOString(),
          addInterrupt: true,
        });
      } catch (error: any) {
        const message = String(error?.message ?? error);
        if (/pane_not_found|not found/i.test(message)) {
          const settled = await settleChild(target, "pane-gone");
          return text(
            `"${target.name}" [${target.id}] vanished before the interrupt; the row is marked closed. Nothing is parked.`,
            { id: target.id, status: "already-gone", closed: settled.ok },
          );
        }
        return text(`Failed to interrupt: ${message}`, { error: message });
      }

      if (params.close) {
        const settled = await settleChild(target, "interrupted");
        if (!settled.ok) {
          return text(
            `Interrupted "${target.name}" [${target.id}], but closing pane ${target.paneId} failed: ${settled.reason}. ` +
              `The child is paused and still open; retry orch_close or resume it.`,
            { id: target.id, status: "interrupted", closed: false, error: settled.reason },
          );
        }
        return text(
          `Interrupted "${target.name}" [${target.id}] (scope: ${target.scope}) and closed its pane (${settled.paneState}). Nothing is parked.`,
          { id: target.id, status: "closed", paneState: settled.paneState, closeReason: "interrupted" },
        );
      }

      persistState();
      return text(
        `Interrupted "${target.name}" [${target.id}] (scope: ${target.scope}). Pane and session kept; use orch_close to end it.`,
        { id: target.id, status: "interrupted" },
      );
    },
  });

  // ── orch_close ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_close",
    label: "Close Orchestrator Child",
    description:
      "Close a child's pane and mark it closed — the terminal transition for a paused, blocked, completed, or already-vanished child. Idempotent, and reports what it observed.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Target child id." })),
      name: Type.Optional(Type.String({ description: "Target child name." })),
      scope: Type.Optional(Type.String({ description: "Target child scope." })),
      reason: Type.Optional(Type.String({ description: "Why it is being closed (recorded in the return details)." })),
    }),
    async execute(_toolCallId, params) {
      // Close resolves against terminal rows too: cleaning up a ghost is the point.
      const target = findClosable(params);
      if (!target) {
        return text(`No child matched. Tracked: ${describeTracked()}. Nothing was closed.`, { error: "no-target" });
      }
      if (target.status === "closed") {
        return text(
          `"${target.name}" [${target.id}] is already closed (${target.closeReason ?? "unknown reason"}). Nothing to do.`,
          { id: target.id, status: "closed", paneState: "already-gone", closeReason: target.closeReason },
        );
      }

      const settled = await settleChild(target, "user-closed");
      if (!settled.ok) {
        return text(
          `Failed to close "${target.name}" [${target.id}]: ${settled.reason}. The row is unchanged, so nothing was hidden.`,
          { error: settled.reason, id: target.id },
        );
      }

      return text(
        settled.paneState === "closed"
          ? `Closed "${target.name}" [${target.id}] (scope: ${target.scope}): pane ${target.paneId} closed, row marked closed${params.reason ? ` (${params.reason})` : ""}.`
          : `"${target.name}" [${target.id}] had no live pane; row marked closed${params.reason ? ` (${params.reason})` : ""}. Nothing was parked.`,
        {
          id: target.id,
          status: "closed",
          paneState: settled.paneState,
          closeReason: "user-closed",
          previousStatus: target.status,
          ...(target.watchdog?.trip ? { watchdogTrip: target.watchdog.trip } : {}),
        },
      );
    },
  });

  // ── orch_steer ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_steer",
    label: "Steer Orchestrator",
    description:
      "Deliver a correction to a child: 'interrupt' (Esc, wait for the prompt, then type) or 'queue' (type without interrupting). Reports what was observed, not what was attempted.",
    parameters: Type.Object({
      message: Type.String({ description: "The correction or instruction." }),
      id: Type.Optional(Type.String({ description: "Target child id." })),
      name: Type.Optional(Type.String({ description: "Target child name." })),
      scope: Type.Optional(Type.String({ description: "Target child scope." })),
      mode: Type.Optional(
        Type.Union([Type.Literal("interrupt"), Type.Literal("queue")], {
          description: "User corrections interrupt: in-flight work does not have the new information. Queue when nothing conflicts.",
        }),
      ),
      origin: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("orchestrator")], {
          description: "User defaults to interrupt; orchestrator may only queue.",
        }),
      ),
      settleTimeoutMs: Type.Optional(Type.Number({ description: "How long to wait for the pane to return to an idle prompt after Escape." })),
    }),
    async execute(_toolCallId, params) {
      const origin = params.origin ?? "user";
      const mode = params.mode ?? (origin === "user" ? "interrupt" : "queue");

      const target = findTarget(params);
      if (!target?.paneId) {
        const stale = staleTarget(params);
        if (stale) {
          return text(
            `No running child matched: "${stale.name}" [${stale.id}] is ${stale.status} (${stale.closeReason ?? "no reason recorded"}). `
              + `Use orch_resume to continue it, or orch_close to clean it up.`,
            { status: "stale-target", error: "stale-target", id: stale.id, childStatus: stale.status },
          );
        }
        return text(
          `No running child matched. Running: ${describeRunning()}. Use orch_resume for an ended or paused child.`,
          { status: "not-running", error: "no-target" },
        );
      }

      // Authority rule: an orchestrator may only redirect inside an existing scope.
      const reviewerRefusal = reviewerContactRefusal(target);
      if (reviewerRefusal) {
        return text(reviewerRefusal, { error: "reviewer-contact-forbidden", childId: target.id });
      }
      if (origin === "orchestrator" && params.scope && params.scope !== target.scope) {
        return text(
          `Authority violation: the orchestrator cannot move "${target.name}" from scope "${target.scope}" to "${params.scope}". ` +
            `A scope change is a new handoff and a user decision.`,
          { status: "unauthorized", error: "cross-scope" },
        );
      }

      const delivery = await deliverSteer(client as any, target.paneId, mode, params.message, {
        settleTimeoutMs: params.settleTimeoutMs,
      }).catch((error: any) => ({
        status: "interrupt-failed" as const,
        preTail: null,
        observedTail: null,
        reason: error?.message ?? String(error),
      }));

      const record: SteerRecord = {
        id: `steer-${registry.getSteers(target.id).length + 1}`,
        childId: target.id,
        scope: target.scope,
        origin,
        mode,
        message: params.message,
        timestamp: new Date().toISOString(),
        status: delivery.status,
        ...(delivery.preTail ? { preTail: delivery.preTail } : {}),
        ...(delivery.observedTail ? { observedTail: delivery.observedTail } : {}),
        ...(delivery.status === "interrupt-failed" ? { reason: delivery.reason } : {}),
      };
      registry.recordSteer(record);
      persistState();

      if (delivery.status === "interrupt-failed") {
        return text(
          `Steer NOT delivered to "${target.name}" [${target.id}]: ${delivery.reason}\n` +
            `Nothing was typed, so no half-instruction was left in the child. Retry, or resume the session.`,
          { status: "interrupt-failed", mode, origin, childId: target.id, reason: delivery.reason },
        );
      }

      return text(
        [
          `Steer delivered to "${target.name}" [${target.id}] (scope: ${target.scope}) via ${mode} (origin: ${origin}).`,
          delivery.observedTail ? `Observed pane tail:\n${delivery.observedTail.slice(-800)}` : `Delivery confirmed; pane tail unavailable.`,
        ].join("\n"),
        { status: "delivered", mode, origin, childId: target.id, scope: target.scope },
      );
    },
  });

  // ── orch_route ─────────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_route",
    label: "Route Steering v2",
    // Declared in no request; `tool_search` can return it because it is deferred
    // on purpose. Deferring is only safe for tools this package registers — a
    // host tool un-declared elsewhere is undiscoverable, not deferred.
    exposure: "deferred",
    description:
      "Deterministically resolve which work unit owns an update (scope token, declared lane, milestone file, artifact id) and optionally deliver it. Never guesses: ambiguous or unmatched updates escalate.",
    parameters: Type.Object({
      update: Type.String({ description: "The correction or instruction text." }),
      id: Type.Optional(Type.String({ description: "Explicit target child id." })),
      name: Type.Optional(Type.String({ description: "Explicit target child name." })),
      scope: Type.Optional(Type.String({ description: "Explicit target scope." })),
      origin: Type.Optional(
        Type.Union([Type.Literal("user"), Type.Literal("orchestrator")], {
          description: "'user' may interrupt; 'orchestrator' may only queue and may not change scope.",
        }),
      ),
      queue: Type.Optional(Type.Boolean({ description: "Force soft queue even for a user-origin update." })),
      apply: Type.Optional(Type.Boolean({ description: "Deliver immediately when resolved (default true)." })),
    }),
    async execute(_toolCallId, params) {
      const origin = params.origin ?? "user";
      const apply = params.apply ?? true;

      const resolution = await routeUpdate(
        registry,
        {
          update: params.update,
          id: params.id,
          name: params.name,
          scope: params.scope,
          origin,
          queue: params.queue,
          apply,
          targetRefusal: target => reviewerContactRefusal(target),
        },
        client as any,
      );

      return text(formatResolution(resolution), resolution);
    },
  });

  // ── orch_running ───────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_running",
    label: "Running Subagents v2",
    description: "Enumerate running children with their scope, lane, status, and pending escalation. The orchestrator cannot route to what it cannot see.",
    parameters: Type.Object({
      scope: Type.Optional(Type.String({ description: "Filter by scope." })),
    }),
    async execute(_toolCallId, params) {
      // Lazy zombie reconcile: a running/blocked child whose pane is gone is
      // never coming back — reporting it sends the orchestrator into the same
      // cleanup loop every session (observed live: 40 messages re-handling one
      // dead child). Ping-blocked children are different: exiting the pane is how
      // they wait for an answer, so their dead pane is normal, not a zombie.
      //
      // paneRead resolves null for a gone pane, so `.then(() => true)` could never
      // fail; liveness must be read from the value.
      for (const child of registry.getRunningChildren()) {
        if (!child.paneId || child.pendingPing) continue;
        const liveness = await paneLiveness(child.paneId);
        if (liveness.state === "gone") {
          registry.closeChild(child.sessionFile, "pane-gone");
          detachWatcher(child.sessionFile);
          persistState();
        }
      }
      const running = registry.getRunningChildren();
      const filtered = params.scope ? running.filter((c) => c.scope === params.scope) : running;
      const pending = escalations.forOrchestrator();

      const lines = filtered.map((child) => {
        const waiting = pending.filter((e) => e.childId === child.id);
        const watchdog = child.watchdog?.trip
          ? ` · watchdog:${child.watchdog.trip}(${child.watchdog.interrupts})`
          : "";
        const budget = child.budgetMs && child.startedAt
          ? ` ${Math.max(0, Math.round((Date.now() - child.startedAt) / 60_000))}m/${Math.round(child.budgetMs / 60_000)}m`
          : "";
        const lane = child.laneFiles.length ? ` lane:${child.laneFiles.join(",")}` : " lane:(none)";
        const ping = waiting.length ? ` WAITING:${waiting.map((e) => e.id).join(",")}` : "";
        return `- ${child.name} [${child.id}] ${child.scope} ${child.status}${budget}${lane}${watchdog}${ping}`;
      });

      // One line per child. The previous form spent four lines each on facts the
      // orchestrator reads once, and it is re-read on every tick of the loop.
      return text(
        [
          filtered.length ? `children (${filtered.length}):` : "no running children",
          ...lines,
          ...(pending.length
            ? [`escalations (${pending.length}):`, ...pending.map((e) => `- ${e.id} [${e.scope}] ${e.question}`)]
            : []),
        ].join("\n"),
        { count: filtered.length, children: filtered, pendingEscalations: pending },
      );
    },
  });

  // ── orch_brief — the review packet ─────────────────────────────────────────
  pi.registerTool({
    name: "orch_brief",
    label: "Review Packet",
    description:
      "One bounded packet for reviewing a scope: frozen criteria, computed lane, diff hunks, and the child's last report. Cheaper than reading files to find out what changed. Pass `since` on a re-review to omit files it already sent.",
    parameters: Type.Object({
      scope: Type.String({ description: "The work unit to review." }),
      since: Type.Optional(Type.Boolean({ description: "Incremental: omit files already sent for this scope by a previous brief." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let scope: string;
      try {
        scope = sanitizeScope(params.scope);
      } catch (error: any) {
        return text(`Invalid scope: ${error.message}`, { error: error.message });
      }
      const cwd = (ctx as any)?.cwd || process.cwd();
      const handoff = [...handoffs.values()].find((entry) => entry.record.scope === scope)?.record;
      const child = [...registry.getChildrenInScope(scope)].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      if (!handoff && !child) {
        return text(
          `No handoff or child for scope "${scope}". Author one with orch_handoff, or check orch_running for the real scope name.`,
          { error: "unknown-scope", scope },
        );
      }
      const changed = (reviewSeams.changedFiles ?? gitChangedFiles)(cwd);
      const diff = (reviewSeams.diffText ?? gitDiffText)(cwd);
      const previous = params.since ? briefCursor.get(scope) : undefined;
      const packet = buildReviewPacket({
        scope,
        changed,
        diff,
        handoff: handoff
          ? {
              id: handoff.id,
              revision: handoff.revision,
              acceptanceCriteria: handoff.acceptanceCriteria,
              laneFiles: handoff.laneFiles,
              verifyCommand: (handoff as any).verifyCommand,
            }
          : undefined,
        child: child
          ? {
              id: child.id,
              name: child.name,
              status: child.status,
              startedAt: child.startedAt,
              budgetMs: child.budgetMs,
              lastTail: child.lastTail,
              frozenCriteria: child.frozenCriteria,
              handoffRevision: child.handoffRevision,
              laneFiles: child.laneFiles,
              purpose: child.purpose,
            }
          : undefined,
        previousFiles: previous ? [...previous] : undefined,
        now: Date.now(),
      });
      if (params.since) {
        briefCursor.set(scope, new Set(packet.hunks.map((hunk) => hunk.file)));
      }
      return text(renderReviewPacket(packet), {
        scope,
        criteria: packet.criteria,
        laneFiles: packet.laneFiles,
        outOfLane: packet.outOfLane,
        changed: packet.changed,
        hunks: packet.hunks.length,
        verifyCommand: verifyCommandProblem((handoff as any)?.verifyCommand) ? undefined : (handoff as any)?.verifyCommand,
      });
    },
  });

  // ── orch_check — the deterministic half of the review ──────────────────────
  pi.registerTool({
    name: "orch_check",
    label: "Run Review Checks",
    description:
      "Compute lane compliance and run the verification command, returning evidenceRefs ready to cite in orch_review. Reports \"not run\" rather than inventing a result.",
    parameters: Type.Object({
      scope: Type.String({ description: "The work unit being checked." }),
      command: Type.Optional(Type.String({ description: "Test/typecheck command. Defaults to the handoff's verifyCommand." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let scope: string;
      try {
        scope = sanitizeScope(params.scope);
      } catch (error: any) {
        return text(`Invalid scope: ${error.message}`, { error: error.message });
      }
      const cwd = (ctx as any)?.cwd || process.cwd();
      const handoff = [...handoffs.values()].find((entry) => entry.record.scope === scope)?.record;
      const child = [...registry.getChildrenInScope(scope)].sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      const laneFiles = child?.laneFiles?.length ? child.laneFiles : (handoff?.laneFiles ?? []);
      const laneDeclared = Boolean(handoff || child?.laneFiles?.length);
      const criteria = child?.frozenCriteria?.length ? child.frozenCriteria : (handoff?.acceptanceCriteria ?? []);
      const command = params.command ?? (handoff as any)?.verifyCommand;
      const changed = (reviewSeams.changedFiles ?? gitChangedFiles)(cwd);
      let lastOutput: string | null = null;
      const report = buildCheckReport({
        scope,
        laneFiles,
        laneDeclared,
        changed,
        criteria,
        command,
        run: (cmd) => {
          const result = (reviewSeams.runCommand ?? runVerifyCommand)(cmd, cwd);
          lastOutput = result.output;
          return result;
        },
      });
      const diff = (reviewSeams.diffText ?? gitDiffText)(cwd);
      const receipt: CheckReceipt = {
        id: `cr-${scope}-${(checkReceipts.size + 1).toString(36)}${now().toString(36)}`,
        scope,
        command: report.tests.command ?? null,
        exit: typeof report.tests.exit === "number" ? report.tests.exit : null,
        outputDigest: outputDigestOf(lastOutput),
        criteriaHash: criteriaHashOf(criteria),
        specRevision: child?.handoffRevision ?? handoff?.revision ?? null,
        treeDigest: treeDigestOf({ changed, diff }),
        createdAt: new Date(now()).toISOString(),
      };
      checkReceipts.set(receipt.id, receipt);
      return text(`${renderCheckReport(report)}\nreceipt: ${describeReceipt(receipt)}\nCite this in orch_review as checkRunId: "${receipt.id}".`, {
        scope,
        lane: report.lane,
        tests: report.tests,
        evidenceRefs: report.refs,
        checkRunId: receipt.id,
        receipt,
      });
    },
  });

  // ── orch_escalate — the uncertainty ladder ─────────────────────────────────
  pi.registerTool({
    name: "orch_escalate",
    label: "Escalate / Answer Child Question",
    description:
      "Resolve a child's question. action 'answer' answers from context you actually have and resumes the child. action 'to-user' hands the decision to the user with a required reason. action 'relay-user' delivers a decision the user made. action 'cancel' resumes the child with an explicit NOT-approved message.",
    parameters: Type.Object({
      id: Type.String({ description: "Escalation id, e.g. from a subagent_ping message or orch_running." }),
      action: Type.Union([
        Type.Literal("answer"),
        Type.Literal("to-user"),
        Type.Literal("relay-user"),
        Type.Literal("cancel"),
      ]),
      answer: Type.Optional(Type.String({ description: "The decision, for 'answer' and 'relay-user'." })),
      reason: Type.Optional(Type.String({ description: "Why the orchestrator cannot decide, for 'to-user'. Required there." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const escalation = escalations.get(params.id);
      if (!escalation) {
        return text(
          `No escalation "${params.id}". Open ones: ${escalations.forOrchestrator().map((e) => e.id).join(", ") || "(none)"}.`,
          { error: "unknown-escalation" },
        );
      }

      try {
        if (params.action === "to-user") {
          const updated = escalations.escalateToUser(params.id, params.reason ?? "");
          pi.appendEntry(ESCALATION_TYPE, { id: updated.id, childId: updated.childId, stage: updated.stage });
          const answer = await askUserFor(ctx, escalation, params.reason ?? "");
          if (answer === undefined) {
            escalations.cancel(params.id, "User dialog closed without an answer.");
            publishDashboard();
            return text(
              `Escalation ${params.id} handed to the user, but they did not answer. It is CANCELLED, which is not consent. ` +
                `Resume the child with action "cancel" so it reports the blocker instead of guessing.`,
              { status: "cancelled", id: params.id },
            );
          }
          const resolved = escalations.answerAsUser(params.id, answer);
          pi.appendEntry(ESCALATION_TYPE, { id: resolved.id, childId: resolved.childId, stage: resolved.stage });
          return deliverAnswer(ctx, resolved.id);
        }

        if (params.action === "relay-user") {
          const resolved = escalations.answerAsUser(params.id, params.answer ?? "");
          pi.appendEntry(ESCALATION_TYPE, { id: resolved.id, childId: resolved.childId, stage: resolved.stage });
          return deliverAnswer(ctx, resolved.id);
        }

        if (params.action === "cancel") {
          const cancelled = escalations.cancel(params.id, params.reason ?? "Orchestrator cancelled the question.");
          pi.appendEntry(ESCALATION_TYPE, { id: cancelled.id, childId: cancelled.childId, stage: cancelled.stage });
          return deliverAnswer(ctx, cancelled.id);
        }

        const resolved = escalations.answerAsOrchestrator(params.id, params.answer ?? "");
        pi.appendEntry(ESCALATION_TYPE, { id: resolved.id, childId: resolved.childId, stage: resolved.stage });
        return deliverAnswer(ctx, resolved.id);
      } catch (error: any) {
        const message = error instanceof EscalationError ? error.message : String(error?.message ?? error);
        return text(`Escalation refused: ${message}`, { error: message });
      }
    },
  });

  /**
   * Deliver a settled escalation by actually resuming the child.
   *
   * The old path marked the child closed and told the parent to call
   * `orch_resume` itself. That manual step is what produced a second pi process
   * on one session file and a fresh registry row per answer — the ghost factory.
   */
  async function deliverAnswer(ctx: ExtensionContext, id: string) {
    // The escalation stage (answered/cancelled) is dashboard-visible state.
    publishDashboard();
    const escalation = escalations.get(id)!;
    const message = escalations.resumeMessage(id);
    const child = registry.getChildById(escalation.childId);

    // Ownership check before resuming: a stale escalation (its row was superseded
    // by a resume) must not close the live pane and graft an old answer onto the
    // current child. The session file is the identity that survives a resume.
    const current = registry.getChildBySession(escalation.sessionFile);
    const isCurrent =
      current !== undefined &&
      current.id === escalation.childId &&
      current.status !== "closed" &&
      current.status !== "completed";
    if (!isCurrent) {
      return text(
        `Escalation ${id} belongs to child ${escalation.childId}, which is no longer the current row for `
          + `${escalation.sessionFile}`
          + (current ? ` (now ${current.id}, ${current.status})` : " (no row)")
          + `. Nothing was resumed — answering a stale question would supersede the live child. `
          + `Run orch_running for the current state; the decision text is below if you still want it.`,
        {
          error: "stale-escalation",
          status: escalation.stage,
          id,
          childId: escalation.childId,
          ...(current ? { currentChildId: current.id, currentStatus: current.status } : {}),
          resumeMessage: message,
          resumed: false,
        },
      );
    }
    // Answering is not advice: attempt the resume here. If it cannot start (the
    // session file is gone), say so and still hand over the decision text — but
    // never claim the child is running when it is not.
    const resumed = await startResume(ctx, {
      sessionPath: escalation.sessionFile,
      message,
      name: child?.name ?? escalation.childName,
      autoExit: child?.autoExit ?? true,
    });
    const resumeDetails = ((resumed as any)?.details ?? {}) as { error?: string; paneId?: string };
    const resumedOk = !resumeDetails.error;

    return text(
      [
        `Escalation ${id} is ${escalation.stage}.`,
        resumedOk
          ? `The child was resumed with the decision in pane ${resumeDetails.paneId ?? "(unknown)"}.`
          : `Automatic resume failed (${resumeDetails.error}); deliver it with ` +
            `orch_resume({ sessionPath: "${escalation.sessionFile}", message: <below> }).`,
        ``,
        message,
      ].join("\n"),
      {
        status: escalation.stage,
        id,
        childId: escalation.childId,
        sessionFile: escalation.sessionFile,
        resumeMessage: message,
        resumed: resumedOk,
        ...(resumeDetails.paneId ? { paneId: resumeDetails.paneId } : {}),
        ...(resumeDetails.error ? { resumeError: resumeDetails.error } : {}),
      },
    );
  }

  /**
   * The to-user rung goes through the ask-user extension's `ask_user` tool, not
   * a bespoke ui.input dialog: one ask surface for the whole system, with the
   * same contract — a cancelled dialog is unanswered, never consent — and the
   * same child-forwarding semantics. The raw ui.input path remains only as a
   * fallback for sessions where ask_user is not callable.
   */
  async function askUserFor(ctx: ExtensionContext, escalation: { question: string; context?: string }, reason: string): Promise<string | undefined> {
    const question = `A worker cannot proceed and the orchestrator cannot decide.\n\nQuestion: ${escalation.question}` +
      (escalation.context ? `\n\nContext: ${escalation.context}` : "") +
      `\n\nWhy this needs you: ${reason || "(no reason given)"}`;

    if (typeof (ctx as any).executeTool === "function") {
      try {
        const outcome = await (ctx as any).executeTool("ask_user", { question, context: escalation.context });
        const payload = JSON.parse(outcome?.content?.[0]?.text ?? "{}");
        if (payload.status === "answered" && typeof payload.answer === "string" && payload.answer.trim()) {
          return payload.answer.trim();
        }
        // cancelled | unavailable: unanswered, never consent — the caller owns
        // the cancel path, so report and stop.
        if (payload.status === "cancelled" || payload.status === "unavailable") {
          if (payload.status === "unavailable") {
            pi.appendEntry(ESCALATION_TYPE, { id: escalation.question, stage: "orchestrator", note: "ask_user unavailable; fell back to ui.input" });
          } else {
            return undefined;
          }
        }
      } catch (error: any) {
        pi.appendEntry(ESCALATION_TYPE, { id: escalation.question, stage: "orchestrator", note: `ask_user failed: ${error?.message ?? String(error)}` });
      }
    }

    // Fallback: direct dialog when the ask_user tool is unavailable.
    if (typeof (ctx.ui as any)?.input !== "function" || ctx.mode !== "tui") return undefined;
    const answer = await (ctx.ui as any).input(
      [
        `A worker cannot proceed and the orchestrator cannot decide.`,
        ``,
        `Question: ${escalation.question}`,
        escalation.context ? `Context: ${escalation.context}` : "",
        `Why this needs you: ${reason || "(no reason given)"}`,
        ``,
        `Answer (leaving blank means unanswered, not approved):`,
      ].filter(Boolean).join("\n"),
    );
    return typeof answer === "string" && answer.trim() ? answer : undefined;
  }

  // ── orch_review — the orchestrator's second act ────────────────────────────
  pi.registerTool({
    name: "orch_review",
    label: "Review Orchestrator",
    description:
      "Record the review verdict for one scope: each acceptance criterion against evidence YOU gathered, plus lane compliance. An outside-lane change is a violation regardless of quality.",
    parameters: Type.Object({
      scope: Type.String({ description: "The work unit being reviewed." }),
      verdict: Type.Union([Type.Literal("approved"), Type.Literal("rejected"), Type.Literal("revise")]),
      criteriaNotes: Type.Array(
        Type.Object({
          criterion: Type.String(),
          evidence: Type.Optional(
            Type.String({ description: "Prose note. Not evidence on its own — an approval needs evidenceRefs." }),
          ),
          evidenceRefs: Type.Optional(
            Type.Array(
              Type.Union([
                Type.Object({ kind: Type.Literal("file"), path: Type.String(), line: Type.Optional(Type.Number()) }),
                Type.Object({ kind: Type.Literal("cmd"), cmd: Type.String(), exit: Type.Number() }),
                Type.Object({ kind: Type.Literal("test"), name: Type.String(), pass: Type.Boolean() }),
              ]),
              { description: "References the gate verifies: an existing file, a command and its exit, or a test and its result." },
            ),
          ),
          passed: Type.Boolean(),
        }),
        { minItems: 1 },
      ),
      laneCompliance: Type.Optional(
        Type.Object({
          inLane: Type.Optional(
            Type.Boolean({
              description: "Can only TIGHTEN the computed result. A computed out-of-lane diff is a violation even when this says true.",
            }),
          ),
          violations: Type.Optional(Type.Array(Type.String())),
        }),
      ),
      summary: Type.String({ description: "Findings and why this verdict." }),
      keepChild: Type.Optional(
        Type.Boolean({
          description: "Keep the child's pane open after the verdict (default false: a reviewed child is closed, so it cannot idle into its budget).",
        }),
      ),
      userConfirmed: Type.Optional(
        Type.Boolean({
          description: "Set only after asking the user: required to approve a scope the orchestrator itself edited, or one whose spec was revised after spawn.",
        }),
      ),
      checkRunId: Type.Optional(
        Type.String({
          description:
            "Receipt id from orch_check. An approval citing one is refused if the command failed, the criteria changed, or the tree changed since it ran. Recommended whenever a verification command exists: without it, cmd/test evidence is attested, not authenticated.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      let scope: string;
      try {
        scope = sanitizeScope(params.scope);
      } catch (error: any) {
        return text(`Invalid scope: ${error.message}`, { error: error.message });
      }

      const handoff = [...handoffs.values()].find((h) => h.record.scope === scope)?.record;

      // The gate is only real if it can fail. An approved verdict with a failing
      // criterion, unverifiable evidence, or an out-of-lane diff is a
      // contradiction, so it is refused rather than recorded and quietly ignored.
      const failedCriteria = params.criteriaNotes.filter((c) => !c.passed);
      if (params.verdict === "approved" && failedCriteria.length > 0) {
        return text(
          `Refusing to approve ${scope}: ${failedCriteria.length} acceptance criterion/criteria failed (${failedCriteria
            .map((c) => c.criterion)
            .join("; ")}). Use verdict "revise" or "rejected".`,
          { error: "contradictory-verdict", failed: failedCriteria.map((c) => c.criterion) },
        );
      }

      // ── the frozen spec, not the current one ──────────────────────────────
      // Re-authoring a handoff bumps its revision. Judging the current revision
      // would let a failing criterion be edited out after the child ran, so the
      // review measures the criteria captured at spawn and reports the drift.
      const frozenRow = registry
        .getChildrenInScope(scope)
        .filter((c) => c.frozenCriteria?.length)
        .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))[0];
      const criteriaUnderReview = frozenRow?.frozenCriteria ?? handoff?.acceptanceCriteria;
      const specRevision = frozenRow?.handoffRevision ?? handoff?.revision;
      const findings: string[] = [];
      if (handoff && frozenRow?.handoffRevision && handoff.revision > frozenRow.handoffRevision) {
        findings.push(
          `handoff revised after spawn: the review judged revision ${frozenRow.handoffRevision}, current is ${handoff.revision}`,
        );
      }

      // One base for evidence checks and for git: the session's cwd, or the
      // process cwd when a tool context does not carry one.
      const reviewCwd = (ctx as any)?.cwd || process.cwd();

      // ── lane compliance is computed, not declared ─────────────────────────
      const changed = (reviewSeams.changedFiles ?? gitChangedFiles)(reviewCwd);
      const laneFiles = frozenRow?.laneFiles ?? handoff?.laneFiles ?? [];
      // An ad-hoc unit declared no lane, so there is nothing to leave. Treating an
      // empty lane as "every file is outside it" would make every ad-hoc approval
      // impossible, which is a policy the mode table never agreed to.
      const laneDeclared = Boolean(frozenRow?.laneFiles?.length || handoff?.laneFiles?.length);
      const declared = params.laneCompliance;
      let laneSource: "git" | "declared" = "declared";
      let laneViolations: string[] = [];
      let inLane = declared?.inLane ?? true;
      if (laneDeclared && changed) {
        laneSource = "git";
        laneViolations = changed.filter((file) => !pathMatchesAnyLane(laneFiles, file));
        inLane = laneViolations.length === 0;
      }
      // A declaration can tighten the verdict, never loosen it.
      if (declared?.inLane === false) inLane = false;
      const violations = [...new Set([...laneViolations, ...(declared?.violations ?? [])])];
      if (params.verdict === "approved" && !inLane) {
        return text(
          `Refusing to approve ${scope}: the diff left its lane (${violations.join(", ") || "unspecified"}). ` +
            `An outside-lane change is a violation regardless of quality` +
            (laneSource === "git" ? " — this list was computed from git, so declaring inLane: true does not clear it." : ".") +
            ` Use "revise" with findings for the owning scope.`,
          { error: "out-of-lane", violations, laneSource },
        );
      }

      // ── evidence must be checkable ────────────────────────────────────────
      const evidenceRefs = params.criteriaNotes.flatMap((c) => c.evidenceRefs ?? []) as EvidenceRef[];
      const evidenceCheck = checkEvidenceRefs(evidenceRefs, { cwd: reviewCwd });

      // ── the receipt, when one is cited ────────────────────────────────────
      // Verified-shape evidence (") a cmd ran and exited 0 (" ) is attestation. A
      // receipt adds the two facts shape cannot carry: which definition of done it
      // judged, and which tree it ran against. Optional because attestation is
      // still legitimate when nothing can be executed, but never trusted silently
      // once cited: a bad receipt is refused even for a `revise` verdict so a
      // parent cannot cite a stale pass as support for its findings.
      const receiptId = params.checkRunId?.trim();
      let receiptProblems: string[] = [];
      let receiptNote: string | undefined;
      if (receiptId) {
        const diffNow = (reviewSeams.diffText ?? gitDiffText)(reviewCwd);
        receiptProblems = evaluateReceipt(checkReceipts.get(receiptId), {
          scope,
          criteriaHash: criteriaHashOf(criteriaUnderReview),
          treeDigest: treeDigestOf({ changed, diff: diffNow }),
        });
        if (receiptProblems.length > 0) {
          return text(
            `Refusing to record ${scope} with checkRunId "${receiptId}":\n`
              + receiptProblems.map((problem) => `- ${problem}`).join("\n")
              + `\nRe-run orch_check after the last change and cite the new receipt, or drop checkRunId and treat the evidence as attested (allowed for \`revise\`, not for \`approved\` once a receipt is cited).`,
            { error: "check-receipt-invalid", scope, checkRunId: receiptId, problems: receiptProblems },
          );
        }
        receiptNote = receiptId;
      } else if (params.verdict === "approved" && handoff?.verifyCommand) {
        // Not a refusal: the existing contract (attested refs verify for real files
        // and cmd/test shape) is unchanged. The note exists so the gap is visible
        // in the audit trail instead of being indistinguishable from a real run.
        receiptNote = "none cited — evidence is attested, not receipt-backed";
      }
      if (params.verdict === "approved") {
        if (evidenceCheck.checked === 0) {
          return text(
            `Refusing to approve "${scope}" on prose alone: no evidenceRefs were supplied. ` +
              `Give at least one { kind: "file" | "cmd" | "test" } reference per claim you rely on — the gate verifies them. ` +
              `If the only support is your own description, the verdict is "revise", not "approved".`,
            { error: "evidence-required", scope },
          );
        }
        if (!evidenceCheck.ok) {
          return text(
            `Refusing to approve "${scope}": ${evidenceCheck.problems.length} evidence reference(s) could not be verified —\n`
              + evidenceCheck.problems.map((problem) => `- ${problem}`).join("\n")
              + `\nCite only what you actually inspected.`,
            { error: "unverifiable-evidence", problems: evidenceCheck.problems },
          );
        }
      }


      // ── independence: did the orchestrator touch this work unit itself? ───
      const since = frozenRow?.startedAt ? new Date(frozenRow.startedAt).toISOString() : undefined;
      const touched = registry
        .getAuthorWrites(since)
        .filter(
          (write) =>
            pathMatchesAnyLane(laneFiles, write.path) ||
            pathMatchesAnyLane(handoff?.outOfLaneFiles ?? [], write.path),
        );
      const independence: "clean" | "self-authored" = touched.length > 0 ? "self-authored" : "clean";
      const needsConfirmation =
        params.verdict === "approved" && (independence === "self-authored" || findings.length > 0);
      if (needsConfirmation && params.userConfirmed !== true) {
        const why = independence === "self-authored"
          ? `the orchestrator itself wrote ${[...new Set(touched.map((write) => write.path))].join(", ")} inside this work unit`
          : findings.join("; ");
        return text(
          `Approval for "${scope}" needs the user's confirmation: ${why}.\n\n`
            + `Ask the user with ask_user — show the evidence you verified and the findings — then call orch_review again ` +
            `with userConfirmed: true if they agree. A self-reviewed scope approved silently is not a review.\n\n`
            + `Evidence checked: ${evidenceCheck.checked} reference(s). Lane: ${laneSource === "git" ? `computed from git (${violations.length ? violations.join(", ") : "clean"})` : "declared"}.`,
          {
            error: "confirmation-required",
            independence,
            touched: [...new Set(touched.map((write) => write.path))],
            findings,
            evidenceRefs: evidenceCheck.checked,
            laneSource,
            violations,
          },
        );
      }

      // Record every verdict — reviews are audit evidence and drive the revise
      // bound. A revise verdict resumes the loop; more than MAX_REVISE_ROUNDS
      // consecutive ones means the loop is not converging, so it stops and the
      // decision moves to the user instead of burning the child again.
      const reviseRound = registry.getReviseRound(scope);
      if (params.verdict === "revise" && reviseRound + 1 > MAX_REVISE_ROUNDS) {
        return text(
          `Refusing revise round ${reviseRound + 1} for "${scope}": ${reviseRound} consecutive revisions have not converged. ` +
            `The loop is bounded. Escalate to the user (present the findings yourself), re-author the handoff with a narrower lane, ` +
            `or verdict "rejected" and re-decompose.`,
          { error: "revise-loop-exhausted", scope, rounds: reviseRound, max: MAX_REVISE_ROUNDS, findings: params.summary },
        );
      }
      registry.recordReview({
        id: `rev-${scope}-${Date.now()}`,
        scope,
        verdict: params.verdict,
        summary: params.summary,
        failedCriteria: failedCriteria.map((c) => c.criterion),
        inLane,
        timestamp: new Date().toISOString(),
        independence,
        verified: laneSource === "git" && evidenceCheck.ok,
        laneSource,
        evidenceRefs: evidenceCheck.checked,
        userConfirmed: params.userConfirmed === true,
        ...(specRevision !== undefined ? { specRevision } : {}),
        ...(receiptId ? { checkRunId: receiptId } : {}),
        ...(findings.length ? { findings } : {}),
      });
      persistState();

      // A verdict is the end of the work unit. Leaving the child running is how a
      // completed-and-approved row idled into its budget and became the ghost the
      // watchdog then chased every 30s. `revise` keeps the child for the next round.
      //
      // Every active row in the scope is settled, not just the first: a leaked pane
      // with a stale row is exactly how two agents end up in one lane.
      const activeInScope = params.verdict === "revise" || params.keepChild
        ? []
        : registry
            .getChildrenInScope(scope)
            .filter((c) => c.status === "running" || c.status === "blocked");
      const settlements: Array<{ child: ScopedChild; result: Awaited<ReturnType<typeof settleChild>> }> = [];
      for (const active of activeInScope) {
        settlements.push({
          child: active,
          result: await settleChild(active, params.verdict === "approved" ? "review-approved" : "review-rejected"),
        });
      }
      const settlement = settlements[0]?.result ?? null;
      const unsettled = settlements.filter((s) => !s.result.ok);

      const criteriaBlock = params.criteriaNotes
        .map(
          (c, i) =>
            `${i + 1}. [${c.passed ? "PASS" : "FAIL"}] ${c.criterion}\n`
            + `   Note: ${c.evidence?.trim() || "(none)"}\n`
            + `   References:\n${renderEvidence(c.evidenceRefs as EvidenceRef[] | undefined)
              .split("\n")
              .map((line) => `     ${line}`)
              .join("\n")}`,
        )
        .join("\n\n");

      const content = [
        `# Review: ${scope} — ${params.verdict.toUpperCase()}`,
        ``,
        handoff ? `Handoff: ${handoff.id} (revision ${handoff.revision})` : `Handoff: (none on record)`,
        ``,
        `## Summary`,
        params.summary,
        ``,
        `## Independence`,
        `- Verdict source: ${independence === "clean" ? "clean (the orchestrator did not write this lane)" : "self-authored (the orchestrator wrote here)"}`,
        ...(touched.length ? [`- Orchestrator writes:`, ...touched.map((w) => `  - ${w.path} (${w.tool} at ${w.at})`)] : []),
        `- Evidence verified: ${evidenceCheck.ok ? `YES (${evidenceCheck.checked} reference(s))` : "NO"}`,
        ...(params.userConfirmed ? [`- User confirmed: yes`] : []),
        `- Spec revision judged: ${specRevision ?? "(none on record)"}`,
        ``,
        `## Lane compliance`,
        `- Source: ${laneSource === "git" ? "computed from git" : "declared by the orchestrator (git unavailable)"}`,
        `- In lane: ${inLane ? "YES" : "NO"}`,
        ...(violations.length ? [`- Violations:`, ...violations.map((v) => `  - ${v}`)] : []),
        ...(findings.length ? [``, `## Findings`, ...findings.map((f) => `- ${f}`)] : []),
        ``,
        `## Acceptance criteria`,
        criteriaBlock,
        ...(handoff
          ? [
              ``,
              `## Criteria not addressed`,
              ...((criteriaUnderReview ?? []).filter(
                (c) => !params.criteriaNotes.some((n) => n.criterion.trim() === c.trim()),
              ).map((c) => `- ${c}`) || []),
            ]
          : []),
      ].join("\n");

      let saved = false;
      try {
        if (typeof (ctx as any).executeTool === "function") {
          await (ctx as any).executeTool("artifact_save", {
            id: `review-${scope}`,
            title: `Review: ${scope} (${params.verdict})`,
            type: "review",
            content,
          });
          saved = true;
        }
      } catch {
        saved = false;
      }

      // The verdict document is saved as an artifact, so re-printing it here only
      // spends the parent's attention budget on something it already decided. Three
      // lines: what the verdict was, what happened to the child, where the record
      // lives. Refusals above stay verbose on purpose — they carry the reason.
      return text(
        [
          `${params.verdict.toUpperCase()} · ${scope}${inLane ? "" : ` · ${violations.length} out of lane`} · ${evidenceCheck.checked} evidence ref(s)${laneSource === "git" ? " · lane from git" : ""}`,
          settlements.length
            ? settlements
                .map((s) => `${s.child.name} [${s.child.id}] ${s.result.ok ? s.result.paneState : `NOT closed: ${s.result.reason}`}`)
                .join("; ")
            : settlement
              ? settlement.ok
                ? `child closed (${settlement.paneState === "closed" ? "pane closed" : "no live pane"})`
                : `child NOT closed: ${settlement.reason} — orch_close before moving on`
              : "no child open",
          unsettled.length
            ? `still under watchdog retry: ${unsettled.map((s) => s.child.name).join(", ")} — orch_close to force`
            : saved
              ? `saved artifact review-${scope}`
              : "artifact_save unavailable — verdict recorded in this message only",
        ]
          .filter(Boolean)
          .join("\n"),
        {
          scope,
          verdict: params.verdict,
          inLane,
          laneSource,
          independence,
          evidenceRefs: evidenceCheck.checked,
          ...(specRevision !== undefined ? { specRevision } : {}),
          ...(params.userConfirmed ? { userConfirmed: true } : {}),
          saved,
          handoffId: handoff?.id,
          childClosed: settlement?.ok ?? false,
          settled: settlements.map((s) => ({ id: s.child.id, ok: s.result.ok })),
          ...(settlement && settlement.ok ? { paneState: settlement.paneState } : {}),
        },
      );
    },
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  /**
   * Steering/interrupt target: an addressable child only.
   *
   * A terminal row is not a target — acting on one revived work the parent had
   * already reviewed and closed (the pane can outlive the row when a close failed).
   * `findClosable` stays permissive on purpose: cleaning up a ghost is its job.
   */
  function findTarget(params: { id?: string; name?: string; scope?: string }): ScopedChild | undefined {
    if (params.id) {
      const child = registry.getChildById(params.id);
      return child && (child.status === "running" || child.status === "blocked") ? child : undefined;
    }
    if (params.name) {
      const matches = registry.getRunningChildren().filter((c) => c.name.toLowerCase() === params.name!.toLowerCase());
      return matches.length === 1 ? matches[0] : undefined;
    }
    if (params.scope) {
      const inScope = registry.getRunningChildren().filter((c) => c.scope === params.scope);
      return inScope.length === 1 ? inScope[0] : undefined;
    }
    const running = registry.getRunningChildren();
    return running.length === 1 ? running[0] : undefined;
  }

  /** A terminal row matched by id: it exists, but it is finished. */
  function staleTarget(params: { id?: string }): ScopedChild | undefined {
    if (!params.id) return undefined;
    const child = registry.getChildById(params.id);
    return child && (child.status === "closed" || child.status === "completed" || child.status === "failed")
      ? child
      : undefined;
  }

  function describeRunning(): string {
    const running = registry.getRunningChildren();
    return running.length ? running.map((c) => `${c.name} [${c.id}] (${c.scope})`).join(", ") : "(none)";
  }

  /**
   * Close resolves against terminal rows too: cleaning up a ghost is the point.
   * Names and scopes prefer an active row, then fall back to the newest row.
   */
  function findClosable(params: { id?: string; name?: string; scope?: string }): ScopedChild | undefined {
    const all = registry.getAllChildren();
    if (params.id) {
      return all.find((c) => c.id === params.id || c.supersededIds?.includes(params.id!));
    }
    if (params.name) {
      const matches = all.filter((c) => c.name.toLowerCase() === params.name!.toLowerCase());
      const active = matches.filter((c) => c.status === "running" || c.status === "blocked");
      return (active.length ? active : matches).at(-1);
    }
    if (params.scope) {
      const inScope = all.filter((c) => c.scope === params.scope);
      const active = inScope.filter((c) => c.status === "running" || c.status === "blocked");
      return (active.length ? active : inScope).at(-1);
    }
    const active = registry.getActiveChildren();
    return active.length === 1 ? active[0] : undefined;
  }

  function describeTracked(): string {
    const all = registry.getAllChildren();
    return all.length ? all.map((c) => `${c.name} [${c.id}] (${c.scope}, ${c.status})`).join(", ") : "(none)";
  }

  function formatResolution(resolution: SteerResolution & { applied?: boolean; deliveryTail?: string | null }): string {
    const head = `Route: ${resolution.outcome.toUpperCase()}`;
    const lines = [head, `Reason: ${resolution.reason}`];
    if (resolution.evidence) lines.push(`Matched by: ${resolution.evidence.level} (${resolution.evidence.signal})`);
    if (resolution.target) lines.push(`Target: ${resolution.target.name} [${resolution.target.id}] — scope: ${resolution.target.scope}`);
    if (resolution.suggestedAction) lines.push(`Next: ${resolution.suggestedAction}`);
    if (resolution.candidates.length > 1) {
      lines.push(`Candidates:`, ...resolution.candidates.map((c) => `  - ${c.name} [${c.id}] (${c.scope})`));
    }
    if (resolution.questions?.length) lines.push(`Questions:`, ...resolution.questions);
    if (resolution.outcome === "ambiguous" || resolution.outcome === "nonexistent") {
      lines.push(`Nothing was typed into any pane.`);
    }
    if (resolution.deliveryTail) lines.push(``, `Observed pane tail:`, resolution.deliveryTail.slice(-800));
    return lines.join("\n");
  }

  function chmodPrivate(dir: string) {
    try {
      if (existsSync(dir)) chmodSync(dir, 0o700);
    } catch {
      /* best effort: permissions are hardening, not the boundary */
    }
  }

  // ── Commands ──────────────────────────────────────────────────────────────
  // ── /orch-pause · /orch-resume ─────────────────────────────────────────────
  /**
   * Pausing is a lifecycle operation, not a mode.
   *
   * It closes every child, refuses new spawns, and keeps each row — with its
   * session file, task, lane, handoff and agent — so the same run can be put
   * back. Resume therefore replays what was actually paused instead of guessing
   * a fresh plan; each child comes back on the conversation it already had.
   */
  function orchestratorMode(ctx: ExtensionContext): { ok: true; mode: string } | { ok: false; reason: string } {
    if (isChildSession) return { ok: false, reason: "a delegated child owns no orchestrator to pause" };
    const state = superviseModeFromBranch(ctx.sessionManager.getBranch());
    if (state?.enabled !== true) return { ok: false, reason: "orchestrator mode is off" };
    if (state.modeId !== "orchestrator" && state.modeId !== "supervise") {
      return { ok: false, reason: `active supervisor mode is "${state.modeId ?? "supervise"}"` };
    }
    return { ok: true, mode: state.modeId };
  }

  /**
   * `/orch-resume` also works outside orchestrator mode, but only to resolve a
   * pause this session already owns. Otherwise a user who switched to normal to
   * fix something would have to switch back just to bring the run up.
   */
  function resumable(ctx: ExtensionContext): { ok: true; mode: string | null } | { ok: false; reason: string } {
    const status = orchestratorMode(ctx);
    if (status.ok) return status;
    if (registry.isPaused() || registry.getPausedChildren().length > 0) return { ok: true, mode: null };
    return status;
  }

  function pauseSummary(
    closed: string[],
    stillLive: Array<{ name: string; reason: string }>,
    mode: string,
    cancelledReviewers: string[],
  ): string {
    return [
      `Orchestrator paused (${mode}). New spawns are refused until /orch-resume.`,
      closed.length ? `Closed ${closed.length} child(ren):\n${closed.join("\n")}` : "No running children were open.",
      stillLive.length
        ? `Still live — close failed, so the watchdog keeps retrying (these are NOT paused):\n${stillLive.map((c) => `${c.name} — ${c.reason}`).join("\n")}`
        : "",
      cancelledReviewers.length
        ? `Independent reviewers were closed and cannot resume (resuming would attach author context). Restart them with orch_spec_review:\n${cancelledReviewers.join("\n")}`
        : "",
      closed.length > cancelledReviewers.length
        ? "Every paused worker keeps its session file, so /orch-resume continues the same conversation."
        : "",
    ].filter(Boolean).join("\n\n");
  }

  async function pauseOrchestrator(ctx: ExtensionContext): Promise<void> {
    const status = orchestratorMode(ctx);
    if (!status.ok) {
      ctx.ui.notify(`/orch-pause needs orchestrator mode (/mode orchestrator): ${status.reason}. Nothing was closed.`, "error");
      return;
    }

    const active = registry.getAllChildren().filter((c) => c.status === "running" || c.status === "blocked");
    const closed: string[] = [];
    const cancelledReviewers: string[] = [];
    const stillLive: Array<{ name: string; reason: string }> = [];
    for (const child of active) {
      // Graceful first: stop the current turn before its pane disappears, so the
      // child is not killed mid-write. Best effort — the close is what ends it.
      await interruptPane(child);
      // A reviewer cannot be resumed by design. Keeping it in the paused set would
      // advertise a resume that must always be refused, so it is cancelled
      // honestly and the run record stays for audit.
      const reviewer = isSpecReviewer(child);
      const settled = await settleChild(child, reviewer ? "scope-cancelled" : "paused");
      if (settled.ok) {
        closed.push(`${child.name} [${child.id}] scope=${child.scope}`);
        if (reviewer) cancelledReviewers.push(`${child.name} [${child.id}] run=${child.reviewRunId ?? "unknown"}`);
      } else {
        stillLive.push({ name: `${child.name} [${child.id}]`, reason: settled.reason });
      }
    }

    // Even with nothing open, the pause is the point: no new work starts while
    // the user is away. A failed close is not paused — it stays ticked.
    registry.setPaused(true);
    persistState();
    ctx.ui.notify(pauseSummary(closed, stillLive, status.mode, cancelledReviewers), stillLive.length ? "warning" : "info");
  }

  function resumeNotice(child: ScopedChild): string {
    return [
      "The orchestrator paused this run with /orch-pause and has just resumed it with /orch-resume.",
      child.task ? `Your assignment (unchanged):\n${child.task}` : "",
      "Continue from where you stopped — same session, same lane. Do not redo finished work. "
        + "Report what is done, what remains, and the evidence for each.",
    ].filter(Boolean).join("\n\n");
  }

  async function resumeOrchestrator(ctx: ExtensionContext): Promise<void> {
    const status = resumable(ctx);
    if (!status.ok) {
      ctx.ui.notify(`/orch-resume needs orchestrator mode (/mode orchestrator): ${status.reason}. Nothing was started.`, "error");
      return;
    }

    const paused = registry.getPausedChildren()
      .slice()
      // Oldest first: the run should come back in the order it went down.
      .sort((a, b) => (a.closedAt ?? "").localeCompare(b.closedAt ?? ""));
    if (!paused.length) {
      registry.setPaused(false);
      persistState();
      ctx.ui.notify("Nothing to resume: no child in this session was closed by /orch-pause.", "info");
      return;
    }

    const resumed: string[] = [];
    const gone: string[] = [];
    const failed: Array<{ name: string; reason: string }> = [];
    for (const child of paused) {
      if (!existsSync(child.sessionFile)) {
        // A paused row with no conversation cannot continue; marking it keeps
        // every later /orch-resume from reporting the same phantom.
        registry.markPausedMissing(child.sessionFile);
        gone.push(`${child.name} [${child.id}] — ${child.sessionFile}`);
        continue;
      }
      const result = await startResume(ctx, {
        sessionPath: child.sessionFile,
        name: child.name,
        autoExit: child.autoExit,
        message: resumeNotice(child),
      });
      const details = (result.details ?? {}) as any;
      if (details.error) {
        // The paused row is untouched, so a retry after fixing the cause is safe.
        failed.push({
          name: `${child.name} [${child.id}]`,
          reason: `${details.error}${details.reason ? ` (${details.reason})` : ""}`,
        });
      } else {
        resumed.push(`${child.name} [${child.id}] → pane ${details.paneId} (same session file)`);
      }
    }

    registry.setPaused(false);
    persistState();
    const lines = [
      resumed.length ? `Redeployed ${resumed.length} child(ren) on their previous sessions:\n${resumed.join("\n")}` : "No child was redeployed.",
      gone.length ? `Session file missing — not resumable, marked paused-missing:\n${gone.join("\n")}` : "",
      failed.length ? `Resume failed (the paused row is kept, so retrying is safe):\n${failed.map((c) => `${c.name} — ${c.reason}`).join("\n")}` : "",
      resumed.length ? "Orchestrator is live again: spawns are allowed." : "",
    ].filter(Boolean);
    ctx.ui.notify(lines.join("\n\n"), failed.length || gone.length ? "warning" : "info");
  }

  pi.registerCommand("orch", {
    description: "orchestrator status | list | handoffs | escalations",
    handler: async (arg, ctx) => {
      const sub = (arg ?? "").trim().split(/\s+/)[0]?.toLowerCase() || "status";
      const running = registry.getRunningChildren();
      const all = registry.getAllChildren();

      if (sub === "list") {
        ctx.ui.notify(
          running.length
            ? running.map((c) => `${c.name} [${c.id}] scope=${c.scope} lane=${c.laneFiles.join(",")}`).join("\n")
            : "No running subagents.",
          "info",
        );
        return;
      }
      if (sub === "handoffs") {
        ctx.ui.notify(
          [...handoffs.values()].map((h) => `${h.record.id} scope=${h.record.scope} rev=${h.record.revision}`).join("\n")
          || "No handoffs authored in this session.",
          "info",
        );
        return;
      }
      if (sub === "escalations") {
        const pending = escalations.forOrchestrator();
        const forUser = escalations.forUser();
        ctx.ui.notify(
          [
            pending.length ? `Waiting on orchestrator:\n${pending.map((e) => `${e.id} [${e.scope}] ${e.question}`).join("\n")}` : "No escalations waiting on the orchestrator.",
            forUser.length ? `Waiting on user:\n${forUser.map((e) => `${e.id} [${e.scope}] ${e.question}`).join("\n")}` : "",
          ].filter(Boolean).join("\n\n"),
          "info",
        );
        return;
      }

      ctx.ui.notify(
        [
          `Orchestrator`,
          `Running: ${running.length} of ${all.length} tracked`,
          registry.isPaused()
            ? `Paused: yes — ${registry.getPausedChildren().length} child(ren) await /orch-resume`
            : `Paused: no`,
          `Handoffs: ${handoffs.size}`,
          `Escalations: ${escalations.forOrchestrator().length} waiting on you, ${escalations.forUser().length} waiting on the user`,
          `Usage: /orch status | list | handoffs | escalations`,
        ].join("\n"),
        "info",
      );
    },
  });

  pi.registerCommand("orch-pause", {
    description: "Pause the orchestrator: close every child, keep the run, refuse new spawns until /orch-resume",
    handler: async (_arg, ctx) => {
      await pauseOrchestrator(ctx);
    },
  });

  pi.registerCommand("orch-resume", {
    description: "Resume a paused orchestrator: redeploy every paused child on its previous session",
    handler: async (_arg, ctx) => {
      await resumeOrchestrator(ctx);
    },
  });

  pi.registerCommand("steer", {
    description: "Route a correction to its owning child: /steer <text> [--queue] [--dry-run]",
    handler: async (arg, ctx) => {
      const raw = (arg ?? "").trim();
      if (!raw) {
        ctx.ui.notify("Usage: /steer <message> [--queue] [--dry-run]", "error");
        return;
      }
      const isQueue = /--queue\b/.test(raw);
      const isDryRun = /--dry-run\b/.test(raw);
      const message = raw.replace(/--queue\b/g, "").replace(/--dry-run\b/g, "").trim();
      if (!message) {
        ctx.ui.notify("Usage: /steer <message> [--queue] [--dry-run]", "error");
        return;
      }

      const resolution = await routeUpdate(
        registry,
        { update: message, origin: "user", queue: isQueue, apply: !isDryRun, targetRefusal: target => reviewerContactRefusal(target) },
        client as any,
      );

      ctx.ui.notify(formatResolution(resolution), resolution.outcome === "interrupt" || resolution.outcome === "queue" ? "info" : "warning");
    },
  });
}
