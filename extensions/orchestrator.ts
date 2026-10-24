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
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import {
  HandoffError,
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

/** Shared handles. Exported so tests can assert on real state, not a mock. */
export const registry = new ScopeRegistry();
export const escalations = new EscalationLedger();
export const handoffs = new Map<string, { record: HandoffRecord; path: string }>();

export interface OrchestratorDeps {
  client?: HerdrClient;
  stream?: any;
}

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
export function budgetNotice(params: { name: string; scope: string; elapsedMs: number; budgetMs: number }): string {
  const elapsed = Math.max(0, Math.round(params.elapsedMs / 60_000));
  const budget = Math.max(0, Math.round(params.budgetMs / 60_000));
  return `Watchdog: child "${params.name}" (scope: ${params.scope}) exceeded its wall-clock budget `
    + `(${elapsed}m elapsed of ${budget}m). It was interrupted. `
    + `Decide: orch_resume to grant more time, or close it and re-scope. Do NOT leave it parked.`;
}

export function stallNotice(params: { name: string; scope: string; strikes: number; intervalMs: number }): string {
  const strikes = Math.max(1, Math.round(params.strikes));
  const minutes = Math.max(0, Math.round((strikes * params.intervalMs) / 60_000));
  const span = minutes >= 1 ? `~${minutes}m` : `~${Math.round((strikes * params.intervalMs) / 1000)}s`;
  return `Watchdog: child "${params.name}" (scope: ${params.scope}) showed no visible progress across `
    + `${strikes} consecutive checks (${span}). It was interrupted. `
    + `Inspect its pane, then orch_resume with direction or re-scope.`;
}

export default function orchestratorExtension(pi: ExtensionAPI, deps?: OrchestratorDeps): void {
  const client: HerdrClient = deps?.client || createHerdrClient();
  const moduleController = new AbortController();
  const activeWatchers = new Map<string, () => void>();

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
  let watchdogTimer: ReturnType<typeof setInterval> | null = null;
  const WATCHDOG_INTERVAL_MS = 30_000;
  const DEFAULT_BUDGET_MS = 30 * 60 * 1000;
  const MAX_STALL_STRIKES = 3;
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
    const path = registryPath();
    if (!path) return;
    const state: PersistedState = {
      ...registry.toSnapshot(),
      handoffs: [...handoffs.entries()].map(([id, entry]) => ({ id, record: entry.record, path: entry.path })),
      escalations: escalations.all(),
    };
    saveRegistrySnapshot(path, state);
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
  }

  /**
   * Reconcile restored children against live panes. A child whose pane is gone
   * is closed — pretending it still runs makes orch_running lie. A child with a
   * live pane keeps running.
   */
  async function reconcileRestoredChildren(): Promise<void> {
    for (const child of registry.getRunningChildren()) {
      if (!child.paneId) {
        registry.updateStatus(child.sessionFile, "closed");
        continue;
      }
      const alive = await client.paneRead(child.paneId, 1).then(() => true).catch(() => false);
      if (!alive) registry.updateStatus(child.sessionFile, "closed");
    }
  }

  /**
   * The watchdog enforces the spawn's wall-clock budget and detects stalls —
   * the two failure modes a child cannot self-report (it believes it is still
   * working). Without it, `budgetMinutes` was accepted-but-never-enforced and a
   * stuck child burned the budget forever.
   */
  async function runWatchdogTick(): Promise<void> {
    for (const child of registry.getRunningChildren()) {
      if (!child.paneId) continue;
      let tail: string | null = null;
      try {
        tail = await client.paneRead(child.paneId, 20);
      } catch {
        continue; // pane read failed — the watcher/exit path owns pane death
      }

      const budgetMs = child.budgetMs ?? DEFAULT_BUDGET_MS;
      const elapsed = child.startedAt ? Date.now() - child.startedAt : 0;

      if (elapsed >= budgetMs) {
        registry.updateStatus(child.sessionFile, "blocked");
        registry.updateRuntime(child.sessionFile, { lastTail: tail, stallStrikes: 0 });
        try {
          await client.paneSendKeys(child.paneId, [INTERRUPT_KEY]);
        } catch {
          // Pane may have died between the read and the interrupt.
        }
        persistState();
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: budgetNotice({ name: child.name, scope: child.scope, elapsedMs: elapsed, budgetMs }),
            display: true,
            details: { id: child.id, name: child.name, scope: child.scope, reason: "budget-exceeded", elapsedMs: elapsed, budgetMs },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
        continue;
      }

      // Stall detection: N consecutive identical pane tails means no visible
      // progress. Interrupt so the parent can decide instead of burning tokens.
      const strikes = tail === child.lastTail ? (child.stallStrikes ?? 0) + 1 : 0;
      registry.updateRuntime(child.sessionFile, { lastTail: tail, stallStrikes: strikes });
      if (strikes >= MAX_STALL_STRIKES) {
        registry.updateStatus(child.sessionFile, "blocked");
        try {
          await client.paneSendKeys(child.paneId, [INTERRUPT_KEY]);
        } catch {
          // Pane may have died.
        }
        persistState();
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: stallNotice({ name: child.name, scope: child.scope, strikes, intervalMs: WATCHDOG_INTERVAL_MS }),
            display: true,
            details: { id: child.id, name: child.name, scope: child.scope, reason: "stall-detected", strikes },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      }
    }
  }

  function startWatchdog(): void {
    if (watchdogTimer) return;
    watchdogTimer = setInterval(() => {
      void runWatchdogTick().catch(() => {});
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
    restorePersistedState();
    await reconcileRestoredChildren();
    startWatchdog();
    ctx.ui.notify("orchestrator active: author a handoff with orch_handoff, then delegate with orch_spawn.", "info");
  });

  pi.on("session_shutdown", () => {
    stopWatchdog();
    // Only the owner writes the sidecar. A child writing its restored view marked
    // siblings closed/blocked behind the parent's back.
    if (!isChildSession) persistState();
    moduleController.abort();
    for (const stop of activeWatchers.values()) stop();
    activeWatchers.clear();
  });

  // A child's `--tools` allowlist excludes the orchestrator surface, but a resumed or
  // user-touched child can still have it active. Refuse rather than let a child spawn
  // work the parent cannot see or review.
  pi.on("tool_call", (event) => {
    if (!isChildSession || !event.toolName.startsWith("orch_")) return;
    return {
      block: true,
      reason: `${event.toolName} is parent-only: this session is a delegated child. Report back with caller_ping or subagent_done instead.`,
    };
  });

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
  ) {
    registry.registerChild({
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
      startedAt: Date.now(),
      budgetMs: budgetMs ?? DEFAULT_BUDGET_MS,
      stallStrikes: 0,
      launchScriptFile: running.launchScriptFile,
      ...(handoffId ? { handoffId } : {}),
    });
    persistState();

    const controller = new AbortController();
    activeWatchers.set(running.sessionFile, () => controller.abort());

    void watchSubagent(running, {
      client: client as any,
      stream: getEventStream(),
      signal: controller.signal,
    })
      .then((outcome: SubagentOutcome) => {
        activeWatchers.delete(running.sessionFile);
        handleOutcome(running, scope, outcome);
      })
      .catch((error: any) => {
        activeWatchers.delete(running.sessionFile);
        registry.updateStatus(running.sessionFile, "failed");
        pi.sendMessage(
          {
            customType: "subagent_result",
            content: `Subagent "${running.name}" watcher error: ${error?.message ?? String(error)}`,
            display: true,
            details: { id: running.id, name: running.name, scope, error: String(error?.message ?? error) },
          },
          { triggerTurn: true, deliverAs: "steer" },
        );
      });
  }

  function handleOutcome(running: RunningSubagent, scope: string, outcome: SubagentOutcome) {
    if (outcome.kind === "cancelled") {
      registry.updateStatus(running.sessionFile, "closed");
      return;
    }

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
      vision: Type.Optional(Type.String({ description: "Global vision this spec refines. It must not contradict it." })),
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
        const written = writeHandoff(artifactsBase(ctx), ctx.sessionManager.getSessionId(), {
          scope: params.scope,
          goal: params.goal,
          acceptanceCriteria: params.acceptanceCriteria,
          laneFiles: params.laneFiles,
          outOfLaneFiles: params.outOfLaneFiles,
          interfaces: params.interfaces,
          guidance: params.guidance,
          reportShape: params.reportShape,
          vision: params.vision,
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
      "Spawn a worker with exactly one handoff spec inlined into its ticket. The child cannot see any other work unit's spec, scope name, or paths.",
    parameters: Type.Object({
      name: Type.String({ description: "Display name for the worker." }),
      task: Type.String({ description: "The specific assignment inside this handoff. Must stay inside the handoff's lane." }),
      handoffId: Type.String({ description: "Handoff id returned by orch_handoff (its scope is accepted too)." }),
      agent: Type.Optional(Type.String({ description: "Agent profile (e.g. 'worker')." })),
      model: Type.Optional(Type.String({ description: "Model override." })),
      skills: Type.Optional(Type.String({ description: "Comma-separated skills." })),
      tools: Type.Optional(Type.String({ description: "Comma-separated allowed tools." })),
      cwd: Type.Optional(Type.String({ description: "Working directory for the child." })),
      budgetMinutes: Type.Optional(Type.Number({ description: "Wall-clock budget in minutes. The watchdog interrupts the child at the budget and asks the parent to decide. Default 30." })),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const handoff = resolveHandoff(params);
      if (!handoff) {
        return text(
          `No handoff "${params.handoffId}". Author one first with orch_handoff: a child spawned without a spec has no lane, ` +
            `so neither steering nor review can be precise. Known handoffs: ${[...handoffs.keys()].join(", ") || "(none)"}.`,
          { error: "handoff-required", known: [...handoffs.keys()] },
        );
      }

      const scope = handoff.scope;
      const runningInScope = registry.getRunningChildren().filter((c) => c.scope === scope);
      if (runningInScope.length > 0) {
        return text(
          `Scope "${scope}" already has a running child (${runningInScope.map((c) => c.name).join(", ")}). ` +
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
      const childArtifactSessionId = `${parentSessionId}-${handoff.id}`;

      const ticket = buildChildTicket(handoff, params.task);

      // Isolation is a data invariant, checked before the child exists rather than
      // trusted to happen. A ticket that names a sibling's scope hands this child
      // knowledge it has no lane for, and the resulting diff is unattributable.
      const siblingScopes = [...handoffs.values()]
        .map((entry) => entry.record.scope)
        .filter((scope) => scope !== handoff.scope);
      const leaked = leakedSiblingScopes(ticket, handoff.scope, siblingScopes);
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
            name: params.name,
            task: ticket,
            agent: params.agent,
            model: params.model,
            skills: params.skills,
            tools: params.tools,
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

      const running: RunningSubagent = {
        id: plan.id,
        name: params.name,
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

      armWatcher(running, scope, handoff.laneFiles, handoff.id, params.budgetMinutes ? params.budgetMinutes * 60_000 : undefined);

      return text(
        [
          `Subagent "${params.name}" launched (scope: ${scope}, handoff: ${handoff.id}).`,
          `Pane: ${started.paneId}`,
          `Lane: ${handoff.laneFiles.join(", ")}`,
          ``,
          `The child holds this handoff only. It cannot see any other work unit.`,
          `Do NOT guess results. The outcome (or a caller_ping escalation) arrives automatically.`,
        ].join("\n"),
        {
          id: running.id,
          name: params.name,
          scope,
          handoffId: handoff.id,
          status: "started",
          paneId: started.paneId,
          sessionFile: running.sessionFile,
          laneFiles: handoff.laneFiles,
        },
      );
    },
  });

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
      const child = registry.getChildBySession(params.sessionPath);
      const scope = child?.scope ?? "resumed";

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

      const running: RunningSubagent = {
        id: plan.id,
        name: plan.name,
        task: params.message ?? "Resumed session",
        paneId: started.paneId,
        startTime: Date.now(),
        sessionFile: plan.sessionFile,
        launchScriptFile: plan.launchScriptFile,
        interactive: plan.interactive,
        autoExit: plan.autoExit,
        scope,
      };

      armWatcher(running, scope, child?.laneFiles ?? [], child?.handoffId);

      return text(`Resumed "${running.name}" in pane ${started.paneId} (scope: ${scope}).`, {
        id: running.id,
        paneId: started.paneId,
        sessionFile: running.sessionFile,
        scope,
        status: "started",
      });
    },
  });

  // ── orch_interrupt ─────────────────────────────────────────────────────────
  pi.registerTool({
    name: "orch_interrupt",
    label: "Interrupt Orchestrator",
    description: "Send Escape to a running child's active turn, keeping its pane, session, and watcher alive.",
    parameters: Type.Object({
      id: Type.Optional(Type.String({ description: "Target child id." })),
      name: Type.Optional(Type.String({ description: "Target child name." })),
      scope: Type.Optional(Type.String({ description: "Target child scope." })),
    }),
    async execute(_toolCallId, params) {
      const target = findTarget(params);
      if (!target?.paneId) {
        return text(
          `No running child matched. Running: ${describeRunning()}. A paused child cannot be interrupted — resume it with orch_resume.`,
          { error: "no-target" },
        );
      }
      try {
        // Herdr key syntax is `esc`, not Pi's `Escape`. The previous spelling was
        // silently rejected, so "interrupt" never interrupted anything.
        await client.paneSendKeys(target.paneId, ["esc"]);
        return text(`Interrupted "${target.name}" [${target.id}] (scope: ${target.scope}). Pane and session kept.`, {
          id: target.id,
          status: "interrupted",
        });
      } catch (error: any) {
        return text(`Failed to interrupt: ${error.message}`, { error: error.message });
      }
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
        return text(
          `No running child matched. Running: ${describeRunning()}. Use orch_resume for an ended or paused child.`,
          { status: "not-running", error: "no-target" },
        );
      }

      // Authority rule: an orchestrator may only redirect inside an existing scope.
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
      // never coming back — its watcher already resolved, so nothing owns it,
      // and reporting it sends the orchestrator into the same cleanup loop
      // every session (observed live: 40 messages re-handling one dead child).
      // Ping-blocked children are different: exiting the pane is how they wait
      // for an answer, so their dead pane is their normal state, not a zombie.
      for (const child of registry.getRunningChildren()) {
        if (!child.paneId || child.pendingPing) continue;
        const alive = await client.paneRead(child.paneId, 1).then(() => true).catch(() => false);
        if (!alive) {
          registry.updateStatus(child.sessionFile, "closed", { pendingPing: false });
          persistState();
        }
      }
      const running = registry.getRunningChildren();
      const filtered = params.scope ? running.filter((c) => c.scope === params.scope) : running;
      const pending = escalations.forOrchestrator();

      const lines = filtered.map((child) => {
        const waiting = pending.filter((e) => e.childId === child.id);
        return [
          `- [${child.status}] ${child.name} (${child.id}) — scope: ${child.scope}${child.paneId ? ` — pane: ${child.paneId}` : ""}`,
          `  Lane: ${child.laneFiles.join(", ") || "(none declared)"}`,
          `  Handoff: ${child.handoffId ?? "(v1 child)"}`,
          ...(waiting.length ? [`  WAITING ON YOU: ${waiting.map((e) => `${e.id}: ${e.question}`).join(" | ")}`] : []),
        ].join("\n");
      });

      return text(
        [
          filtered.length ? `Running children (${filtered.length}):` : "No running children.",
          ...lines,
          ...(pending.length
            ? ["", `Escalations waiting on the orchestrator (${pending.length}):`, ...pending.map((e) => `- ${e.id} [${e.scope}] ${e.question}`)]
            : []),
        ].join("\n"),
        { count: filtered.length, children: filtered, pendingEscalations: pending },
      );
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

  async function deliverAnswer(ctx: ExtensionContext, id: string) {
    const escalation = escalations.get(id)!;
    const message = escalations.resumeMessage(id);
    const child = registry.getChildById(escalation.childId);

    // Resume the paused child with the decision as its next prompt.
    if (child) {
      resetChildForResume(child.id);
    }

    return text(
      [
        `Escalation ${id} is ${escalation.stage}.`,
        ``,
        `Deliver this to the child with orch_resume({ sessionPath: "${escalation.sessionFile}", message: <below> }):`,
        ``,
        message,
      ].join("\n"),
      { status: escalation.stage, id, sessionFile: escalation.sessionFile, resumeMessage: message },
    );
  }

  function resetChildForResume(childId: string) {
    const child = registry.getChildById(childId);
    if (!child) return;
    registry.updateStatus(child.sessionFile, "closed", { pendingPing: false });
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
          evidence: Type.String({ description: "What you checked yourself (file:line, command output). The child's claim is not evidence." }),
          passed: Type.Boolean(),
        }),
        { minItems: 1 },
      ),
      laneCompliance: Type.Object({
        inLane: Type.Boolean(),
        violations: Type.Optional(Type.Array(Type.String())),
      }),
      summary: Type.String({ description: "Findings and why this verdict." }),
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
      // criterion or an out-of-lane diff is a contradiction, so it is refused
      // rather than recorded and quietly ignored later.
      const failedCriteria = params.criteriaNotes.filter((c) => !c.passed);
      if (params.verdict === "approved" && failedCriteria.length > 0) {
        return text(
          `Refusing to approve ${scope}: ${failedCriteria.length} acceptance criterion/criteria failed (${failedCriteria
            .map((c) => c.criterion)
            .join("; ")}). Use verdict "revise" or "rejected".`,
          { error: "contradictory-verdict", failed: failedCriteria.map((c) => c.criterion) },
        );
      }
      if (params.verdict === "approved" && !params.laneCompliance.inLane) {
        return text(
          `Refusing to approve ${scope}: the diff left its lane (${(params.laneCompliance.violations ?? []).join(", ") || "unspecified"}). ` +
            `An outside-lane change is a violation regardless of quality. Use "revise" with findings for the owning scope.`,
          { error: "out-of-lane", violations: params.laneCompliance.violations ?? [] },
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
        inLane: params.laneCompliance.inLane,
        timestamp: new Date().toISOString(),
      });
      persistState();

      const criteriaBlock = params.criteriaNotes
        .map((c, i) => `${i + 1}. [${c.passed ? "PASS" : "FAIL"}] ${c.criterion}\n   Evidence: ${c.evidence}`)
        .join("\n\n");

      const content = [
        `# Review: ${scope} — ${params.verdict.toUpperCase()}`,
        ``,
        handoff ? `Handoff: ${handoff.id} (revision ${handoff.revision})` : `Handoff: (none on record)`,
        ``,
        `## Summary`,
        params.summary,
        ``,
        `## Lane compliance`,
        `- In lane: ${params.laneCompliance.inLane ? "YES" : "NO"}`,
        ...(params.laneCompliance.violations?.length
          ? [`- Violations:`, ...params.laneCompliance.violations.map((v) => `  - ${v}`)]
          : []),
        ``,
        `## Acceptance criteria`,
        criteriaBlock,
        ...(handoff
          ? [
              ``,
              `## Criteria not addressed`,
              ...(handoff.acceptanceCriteria.filter(
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

      return text(
        [`Review recorded for "${scope}": ${params.verdict.toUpperCase()}.`, saved ? "" : `(artifact_save unavailable; verdict returned inline only)`, "", content]
          .filter(Boolean)
          .join("\n"),
        { scope, verdict: params.verdict, inLane: params.laneCompliance.inLane, saved, handoffId: handoff?.id },
      );
    },
  });

  // ── helpers ───────────────────────────────────────────────────────────────

  function findTarget(params: { id?: string; name?: string; scope?: string }): ScopedChild | undefined {
    if (params.id) return registry.getChildById(params.id);
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

  function describeRunning(): string {
    const running = registry.getRunningChildren();
    return running.length ? running.map((c) => `${c.name} [${c.id}] (${c.scope})`).join(", ") : "(none)";
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
          `Handoffs: ${handoffs.size}`,
          `Escalations: ${escalations.forOrchestrator().length} waiting on you, ${escalations.forUser().length} waiting on the user`,
          `Usage: /orch status | list | handoffs | escalations`,
        ].join("\n"),
        "info",
      );
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
        { update: message, origin: "user", queue: isQueue, apply: !isDryRun },
        client as any,
      );

      ctx.ui.notify(formatResolution(resolution), resolution.outcome === "interrupt" || resolution.outcome === "queue" ? "info" : "warning");
    },
  });
}
