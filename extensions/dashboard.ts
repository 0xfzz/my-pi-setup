/**
 * dashboard — the parent-only DashboardProducer lease.
 *
 * This extension is the one place that decides whether a session is allowed to
 * appear as a top-level dashboard session, and when. It listens to notifications
 * from the mode, delegation, and artifact publishers; it never reaches into
 * their modules.
 *
 * Registration is deliberately late and narrow:
 * - loading the extension creates no server, socket, or timer;
 * - a refused mode switch publishes nothing, so it cannot start one;
 * - a verified child (or a seeded/forked child) never registers top-level state;
 * - the producer starts on the first delegated child or a branch restore
 *   that has live children, and re-entry reuses the same lease.
 *
 * Changing mode keeps the lease and publishes the new mode, so a
 * browser watcher sees the transition without losing the observed work.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { meaningfulSessionTitle, sessionTitle } from "../lib/naming.ts";
import { DASHBOARD_GOAL_ENTRY, latestGoalTitle, type GoalTitleRecord } from "../lib/dashboard/goal-title.ts";

import {
  DASHBOARD_ARTIFACTS_EVENT,
  DASHBOARD_MODE_EVENT,
  DASHBOARD_REQUEST_EVENT,
  DASHBOARD_STATE_EVENT,
} from "../lib/dashboard/protocol.ts";
import {
  DashboardBridge,
  defaultDashboardProducerFactory,
  requestDashboardSync,
  type DashboardArtifactsNotice,
  type DashboardModeNotice,
  type DashboardProducerFactory,
  type DashboardStateNotice,
} from "../lib/dashboard/integration.ts";
import { projectSession } from "../lib/dashboard/projection.ts";
import { childContextState, isSubagentChildSession } from "../lib/subagent-context.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import { snapshotToWebView } from "../lib/dashboard/web-view.ts";
import type { DashboardSnapshot } from "../lib/dashboard/protocol.ts";

export interface DashboardExtensionOptions {
  /**
   * Test/embedding seam. Defaults to the lazy runtime factory for
   * `lib/dashboard/producer.ts`; the DashboardProducer constructor contract is
   * unchanged (`{ onReady?, onError?, runtimeDir?, heartbeatMs? }`, publish, close).
   */
  producerFactory?: DashboardProducerFactory;
  /** Coalescing window for mutation snapshots. Default 100ms. */
  coalesceMs?: number;
  /** Optional override passed through to the producer. */
  runtimeDir?: string;
  heartbeatMs?: number;
}

function childGuard(context: ExtensionContext): boolean {
  try {
    const provenChild = isSubagentChildSession(context);
    if (provenChild) return true;
    const manager = context?.sessionManager as any;
    const branch = typeof manager?.getBranch === "function" ? manager.getBranch() : [];
    const header = typeof manager?.getHeader === "function" ? manager.getHeader() : undefined;
    return childContextState(branch, header, provenChild).seeded;
  } catch {
    // If identity cannot be proven, the safe answer is "not a top-level parent".
    return true;
  }
}

export default function dashboardExtension(pi: ExtensionAPI, options: DashboardExtensionOptions = {}) {
  let ctx: ExtensionContext | undefined;
  let verifiedParent = false;
  let mode = "normal";
  let reportedError = false;
  /**
   * One-way latch: delegated work exists, so the graph must exist too.
   *
   * A Normal-mode `agent_spawn` never passes through a mode transition,
   * which used to be the only thing that started the producer. The latch is not
   * reset when the mode changes: leaving the mode keeps the lease and publishes
   * `mode: "normal"`, because the children are still running.
   */
  let registeredForWork = false;

  const baseFactory = options.producerFactory ?? defaultDashboardProducerFactory;
  const producerFactory: DashboardProducerFactory = async (producerOpts) => {
    const producer = await baseFactory(producerOpts);
    return {
      publish(snapshot: DashboardSnapshot) {
        try {
          publishWebView(pi, "dashboard", snapshotToWebView(snapshot));
        } catch {
          // guarded by try/catch so nothing thrown can reach the dashboard flow
        }
        producer.publish(snapshot);
      },
      close() {
        return producer.close?.();
      },
    };
  };

  const bridge = new DashboardBridge({
    producerFactory,
    coalesceMs: options.coalesceMs,
    runtimeDir: options.runtimeDir,
    heartbeatMs: options.heartbeatMs,
    onReady: (url) => {
      if (!url) return;
      try {
        ctx?.ui?.notify?.(`Dashboard: ${url}`, "info");
      } catch {
        // A UI notification is a courtesy; the producer is already live.
      }
    },
    onError: (error) => {
      if (reportedError) return;
      reportedError = true;
      const message = error instanceof Error ? error.message : String(error ?? "unknown error");
      try {
        ctx?.ui?.notify?.(`Dashboard unavailable: ${message}. Orchestration is unaffected.`, "warning");
      } catch {
        // Never let dashboard reporting disrupt a tool or mode transition.
      }
    },
  });

  function bind(context: ExtensionContext): void {
    ctx = context;
    bridge.reopen();
    verifiedParent = !childGuard(context);
    if (!verifiedParent) return;
    refreshTitle(context, true);
  }

  function refreshTitle(context: ExtensionContext, seed = false): void {
    if (!verifiedParent) return;
    const session = projectSession(context, mode);
    if (seed && !latestGoalTitle(context.sessionManager.getBranch(), session.id)) {
      const title = meaningfulSessionTitle(session.name, { project: session.project });
      if (title && title !== sessionTitle({ project: session.project })) {
        pi.appendEntry(DASHBOARD_GOAL_ENTRY, {
          v: 1, ownerSessionId: session.id, title, source: "seed",
        } satisfies GoalTitleRecord);
      }
    }
    bridge.setSession(projectSession(context, mode));
  }

  function setGoal(context: ExtensionContext, value: string, source: "goal" | "rename"): string {
    if (childGuard(context)) throw new Error("Only parent sessions can set the dashboard goal.");
    const session = projectSession(context, mode);
    const title = meaningfulSessionTitle(value, { project: session.project });
    if (source === "goal" && !title) throw new Error("Use a meaningful goal title, not an id or generated session label.");
    const previous = latestGoalTitle(context.sessionManager.getBranch(), session.id);
    if (!previous || previous.title !== title) {
      pi.appendEntry(DASHBOARD_GOAL_ENTRY, {
        v: 1, ownerSessionId: session.id, title, source,
      } satisfies GoalTitleRecord);
    }
    if (verifiedParent) refreshTitle(context);
    return title;
  }

  pi.registerTool({
    name: "session_goal",
    label: "Session goal",
    description: "Set the parent's current user-facing goal title. Updates the dashboard live and persists on the current branch. Not a task/claim/status update.",
    promptGuidelines: ["When the user's overall objective changes, call session_goal with a concise goal title. Keep it for the whole objective; never rename for internal review, verification, handoff or todo bookkeeping."],
    parameters: Type.Object({ title: Type.String({ minLength: 1, maxLength: 200, description: "Concise current user objective, e.g. Dashboard polish" }) }),
    async execute(_id, params, _signal, _update, context) {
      const title = setGoal(context, params.title, "goal");
      pi.setSessionName(title);
      return { content: [{ type: "text", text: `Session goal: ${title}` }], details: { title } };
    },
  });

  pi.registerCommand("session-goal", {
    description: "Set/show the current goal title (also accepts Pi's /name)",
    handler: async (args, context) => {
      if (args.trim()) {
        const title = setGoal(context, args, "goal");
        pi.setSessionName(title);
      }
      context.ui.notify(`Session goal: ${projectSession(context, mode).name}`, "info");
    },
  });

  // Pi emits this for /name and ExtensionAPI.setSessionName(). Its getter is
  // file-global; the event lets us capture explicit renames at this branch.
  pi.on("session_info_changed", (event, context) => {
    if (childGuard(context)) return;
    setGoal(context, event.name ?? "", "rename");
  });

  // The first durable user plan seeds identity only after being appended. Later
  // task/plan churn cannot overwrite a recorded goal. No chat parsing needed.
  pi.on("tool_result", (_event, context) => {
    if (verifiedParent) refreshTitle(context, true);
  });

  function onMode(data: unknown): void {
    const notice = data as Partial<DashboardModeNotice> | undefined;
    const next = typeof notice?.mode === "string" ? notice.mode : "";
    if (!next) return;
    mode = next;
    bridge.observeMode(next);
    if (!verifiedParent) return;
    // A mode name never starts the dashboard. Delegated work does: the first
    // child starts registration in onState, and a mode switch only relabels the
    // snapshot. The old mode-name gate is why a Normal-mode spawn never
    // appeared in the graph.
    bridge.schedule();
  }

  function onState(data: unknown): void {
    if (!verifiedParent) return;
    const notice = data as Partial<DashboardStateNotice> | undefined;
    if (!notice?.delegation) return;
    bridge.observeDelegation(notice.delegation, notice.childSessions);
    // The first child is the signal, not the mode. A Normal-mode spawn is still
    // delegated work and must appear in the graph; a second publish reuses the
    // lease rather than creating another producer.
    if (!registeredForWork && (notice.delegation?.children.length ?? 0) > 0) {
      registeredForWork = true;
      void bridge.start();
    }
  }

  function onArtifacts(data: unknown): void {
    if (!verifiedParent) return;
    const notice = data as Partial<DashboardArtifactsNotice> | undefined;
    if (!Array.isArray(notice?.artifacts)) return;
    bridge.observeArtifacts(notice.artifacts);
  }

  function onRequest(): void {
    if (!verifiedParent) return;
    // Ask every publisher to re-emit current state; load order cannot have lost
    // the initial snapshot because the request is answered now.
    if (ctx) refreshTitle(ctx, true);
    requestDashboardSync(pi);
    bridge.flush();
  }

  pi.events?.on(DASHBOARD_MODE_EVENT, onMode);
  pi.events?.on(DASHBOARD_STATE_EVENT, onState);
  pi.events?.on(DASHBOARD_ARTIFACTS_EVENT, onArtifacts);
  pi.events?.on(DASHBOARD_REQUEST_EVENT, onRequest);

  pi.on("session_start", (_event, context) => {
    bind(context);
    if (!verifiedParent) return;
    requestDashboardSync(pi);
  });

  // A branch/session move can change the session id, leaf, or restored mode. The
  // mode/artifact publishers republish from their own restore(); the bridge only
  // needs the new session identity and a fresh request.
  pi.on("session_tree", (_event, context) => {
    bind(context);
    if (!verifiedParent) return;
    requestDashboardSync(pi);
    bridge.flush();
  });

  pi.on("session_shutdown", () => {
    verifiedParent = false;
    registeredForWork = false;
    ctx = undefined;
    void bridge.close().catch(() => {});
  });
}
