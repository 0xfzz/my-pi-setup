/**
 * Workflow todo: an intent graph the agent can read, not a compliance record it
 * must service.
 *
 * Three tools, one purpose each:
 *   todo_plan  declare intent (goal + tasks + dependencies)
 *   todo_act   the only transition (claim / done / failed / dropped)
 *   todo_next  read the frontier
 *
 * Deliberately absent, because they were the bug:
 *   - the "assess before any work tool" gate, and its `skip`/`continue` actions
 *   - `adminRounds` / `loopSteers` loop police
 *   - `blocked` / `waiting` statuses (now derived from deps and leases)
 *   - free-text "evidence" (now typed refs the harness checks)
 *   - "done" without a resolvable ref, and `cancel` demands for a reason
 *   - re-syncing the whole array to move one item
 *
 * What survives from v1 because it was right: append-only persistence, compact
 * state, the single-writer claim idea, the sidebar/dialog UI, and fail-open
 * behaviour. `workflow_todo` remains as a translating shim for one version.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import {
  PopupPanel,
  MarkdownPopup,
  popupOverlayOptions,
  isPopupCloseKey,
  type PopupRow,
} from "../lib/popup.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";
import { TODO_DETAILS_HINT } from "../lib/workflow-actions.ts";
import { planModeFromBranch } from "../lib/plan-mode.ts";
import { childContextState, isSubagentChildSession } from "../lib/subagent-context.ts";
import * as G from "../lib/intent-graph.ts";

const ENTRY = "workflow-todo:v2";
export const WORKFLOW_TODO_ENTRY = ENTRY;
const LEGACY_ENTRY = "workflow-todo:v1";

// The tool names live in lib/todo-tools.ts so policy modules can classify a todo
// call without importing this extension. Imported for local use and re-exported
// because the extension is the public surface its tests drive.
import { PLAN_TOOL, ACT_TOOL, NEXT_TOOL, LEGACY_TOOL, TODO_TOOL_NAMES, isTodoTool } from "../lib/todo-tools.ts";
export { PLAN_TOOL, ACT_TOOL, NEXT_TOOL, LEGACY_TOOL, TODO_TOOL_NAMES, isTodoTool };

export type WorkflowMode = "normal" | "plan";

// ── Guidance ────────────────────────────────────────────────────────────────

export const GUIDANCE = `Workflow todos (optional, for multi-step or long-horizon work):
todo_next shows what is ready now. todo_plan declares a goal and its tasks with optional deps and a file resource. todo_act claims one task, then settles it done with evidence refs the harness checks ({kind:"file",path}, {kind:"test",name,pass}) or failed/dropped with a reason. Blocked and waiting are computed, so never declare them. Do not claim done without evidence. Skip all three tools for work you can finish in one step.`;

export const PLAN_GUIDANCE = `Workflow todos (optional, Plan mode): the same three tools, used to track read-only research and artifact work. Plan mode itself blocks writing; a task title is not a permission, so never assert that a todo authorises an edit. Evidence is still required to settle a task done.`;

export function getTodoGuidance(mode: WorkflowMode = "normal"): string {
  return mode === "plan" ? PLAN_GUIDANCE : GUIDANCE;
}

export function currentWorkflowMode(branch: readonly any[] | undefined): WorkflowMode {
  return planModeFromBranch(branch)?.enabled ? "plan" : "normal";
}

// ── Icons ───────────────────────────────────────────────────────────────────

/** Accepts v2 statuses and the v1 vocabulary so old session views still render. */
export function todoIcon(status: string): string {
  switch (status) {
    case "done": return "\u{f0132}";
    case "claimed":
    case "in_progress": return "\u{f0450}";
    case "failed":
    case "dropped":
    case "cancelled": return "\u{f0156}";
    case "blocked": return "\u{f0156}";
    default: return "\u{f0131}";
  }
}

// ── Schemas ─────────────────────────────────────────────────────────────────

const EvidenceSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("file"), Type.Literal("cmd"), Type.Literal("test"),
    Type.Literal("artifact"), Type.Literal("commit"), Type.Literal("url"),
  ], { description: "file and test are verified by the harness; cmd, artifact, commit and url are attested" }),
  path: Type.Optional(Type.String({ description: "kind=file: repo-relative path" })),
  line: Type.Optional(Type.Integer({ minimum: 1 })),
  cmd: Type.Optional(Type.String({ description: "kind=cmd: the command you ran" })),
  exit: Type.Optional(Type.Integer({ description: "kind=cmd: its exit code" })),
  name: Type.Optional(Type.String({ description: "kind=test: test name" })),
  pass: Type.Optional(Type.Boolean({ description: "kind=test: did it pass" })),
  id: Type.Optional(Type.String({ description: "kind=artifact: artifact id" })),
  version: Type.Optional(Type.Integer({ minimum: 1 })),
  sha: Type.Optional(Type.String({ description: "kind=commit: commit sha" })),
  url: Type.Optional(Type.String({ description: "kind=url: http(s) link" })),
});

export const TodoPlanParameters = Type.Object({
  goal: Type.String({ minLength: 1, maxLength: 2000, description: "The request this plan serves, near-verbatim. It is the plan's identity." }),
  tasks: Type.Array(Type.Object({
    title: Type.String({ minLength: 1, maxLength: 500, description: "Imperative one-line task" }),
    deps: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: "Task ids or titles that must be done first" })),
    resource: Type.Optional(Type.String({ description: "Exclusive work key, e.g. file:extensions/todo.ts" })),
    note: Type.Optional(Type.String({ maxLength: 1000 })),
  }), { minItems: 1, maxItems: 100 }),
  scope: Type.Optional(Type.Union([Type.Literal("committed"), Type.Literal("scratch")], {
    description: "committed (default) survives the turn and is re-injected once per turn; scratch dies with this turn",
  })),
  replace: Type.Optional(Type.Boolean({ description: "Replace an existing plan for a different goal" })),
});

export const TodoActParameters = Type.Object({
  id: Type.String({ minLength: 1, description: "Task id from todo_next" }),
  transition: Type.Union([Type.Literal("claim"), Type.Literal("done"), Type.Literal("failed"), Type.Literal("dropped")]),
  evidence: Type.Optional(Type.Array(EvidenceSchema, { minItems: 1, maxItems: 20, description: "Required for done" })),
  reason: Type.Optional(Type.String({ maxLength: 2000, description: "Why it failed or was dropped" })),
  note: Type.Optional(Type.String({ maxLength: 2000, description: "Free text; never used as evidence" })),
  ttlMinutes: Type.Optional(Type.Integer({ minimum: 1, maximum: 1440, description: "Claim lease in minutes (default 30)" })),
});

export const TodoNextParameters = Type.Object({
  id: Type.Optional(Type.String({ description: "Show one task with its evidence instead of the board" })),
});

/** v1 surface, kept so an in-flight session's model calls still work. */
export const WorkflowTodoParameters = Type.Object({
  action: Type.Optional(Type.Union([
    Type.Literal("sync"), Type.Literal("skip"), Type.Literal("plan"), Type.Literal("continue"),
    Type.Literal("add"), Type.Literal("update"), Type.Literal("modify"), Type.Literal("cancel"), Type.Literal("list"),
  ], { description: "Deprecated. Prefer todo_plan / todo_act / todo_next." })),
  todos: Type.Optional(Type.Array(Type.Object({
    id: Type.Optional(Type.Integer({ minimum: 1 })),
    text: Type.String({ minLength: 1, maxLength: 500 }),
    activeText: Type.Optional(Type.String({ maxLength: 500 })),
    status: Type.Union([
      Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"),
      Type.Literal("blocked"), Type.Literal("waiting"), Type.Literal("cancelled"),
    ]),
    evidence: Type.Optional(Type.String({ maxLength: 2000 })),
    reason: Type.Optional(Type.String({ maxLength: 2000 })),
  }), { minItems: 1, maxItems: 50 })),
  reason: Type.Optional(Type.String({ maxLength: 2000 })),
  steps: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 500 }), { minItems: 1, maxItems: 30 })),
  text: Type.Optional(Type.String({ minLength: 1, maxLength: 500 })),
  activeText: Type.Optional(Type.String({ maxLength: 500 })),
  id: Type.Optional(Type.Integer({ minimum: 1 })),
  status: Type.Optional(Type.Union([
    Type.Literal("pending"), Type.Literal("in_progress"), Type.Literal("done"),
    Type.Literal("blocked"), Type.Literal("waiting"), Type.Literal("cancelled"),
  ])),
  evidence: Type.Optional(Type.String({ maxLength: 2000 })),
  offset: Type.Optional(Type.Integer({ minimum: 0 })),
  autoAdvance: Type.Optional(Type.Boolean()),
});

export { EvidenceSchema };

/** One uniform result shape across the four tools keeps the registry generic satisfied. */
type TodoResult = { content: { type: "text"; text: string }[]; details: any; structuredContent?: any };

/** Declared so codemode scripts receive the graph as data instead of prose. */
const PlanOutput = Type.Object({
  planId: Type.Optional(Type.String()),
  scope: Type.Optional(Type.String()),
  done: Type.Optional(Type.Integer()),
  total: Type.Optional(Type.Integer()),
  ready: Type.Optional(Type.Array(Type.String())),
  tasks: Type.Optional(Type.Array(Type.Object({
    id: Type.String(), title: Type.String(), status: Type.String(),
  }))),
  workflowTodo: Type.Optional(Type.Boolean()),
});

const detailsOf = (p: G.Plan, now: number) => ({
  ...G.boardSummary(p, now),
  tasks: p.tasks.map(task => ({ id: task.id, title: task.title, status: task.status })),
  workflowTodo: true,
});
export const TodoStatusSchema = Type.Union([
  Type.Literal("open"), Type.Literal("claimed"), Type.Literal("done"),
  Type.Literal("failed"), Type.Literal("dropped"),
]);

// ── Extension ───────────────────────────────────────────────────────────────

export default function todoExtension(pi: ExtensionAPI) {
  let plan: G.Plan | undefined;
  let uiContext: ExtensionContext | undefined;
  let dialogOpen = false;
  let lastInjected = "";
  let lastNudgedClaim = "";
  /** A declaration or a settlement. A mere claim is NOT progress: it is a promise. */
  let progressThisTurn = false;
  void progressThisTurn;
  let childOwned = false;

  const getBranch = (ctx?: ExtensionContext) => (ctx ?? uiContext)?.sessionManager?.getBranch?.();
  const getMode = (ctx?: ExtensionContext): WorkflowMode => currentWorkflowMode(getBranch(ctx));
  const sessionId = (ctx: ExtensionContext): string =>
    ctx.sessionManager.getHeader?.()?.id ?? "session";

  const resolver: G.EvidenceResolver = {
    fileExists: (path: string) => {
      try { return existsSync(path) || existsSync(`${process.cwd()}/${path}`); } catch { return false; }
    },
  };

  // ── Persistence: the log is the truth ───────────────────────────────────
  const append = (ctx: ExtensionContext, entry: G.Entry): void => {
    pi.appendEntry(ENTRY, { ...entry, ownerSessionId: sessionId(ctx) });
    plan = G.replay(branchEntries(ctx));
    draw(ctx);
  };

  const branchEntries = (ctx: ExtensionContext): G.Entry[] => {
    const out: G.Entry[] = [];
    const header = ctx.sessionManager.getHeader?.();
    const isolate = childOwned;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      if (entry.customType === ENTRY) {
        const data = entry.data as G.Entry & { ownerSessionId?: string };
        if (!data || data.v !== G.STATE_VERSION) continue;
        if (isolate && data.ownerSessionId && data.ownerSessionId !== header?.id) continue;
        out.push(data);
      }
    }
    return out;
  };

  const restore = (ctx: ExtensionContext) => {
    plan = undefined;
    lastInjected = "";
    lastNudgedClaim = "";
    progressThisTurn = false;
    const header = ctx.sessionManager.getHeader?.();
    const isolate = childContextState(ctx.sessionManager.getBranch(), header, isSubagentChildSession(ctx)).seeded;
    childOwned = isolate;

    const entries: G.Entry[] = [];
    let legacy: G.Plan | undefined;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom") continue;
      const data = entry.data as any;
      if (entry.customType === ENTRY) {
        if (!data || data.v !== G.STATE_VERSION) continue;
        if (isolate && data.ownerSessionId && data.ownerSessionId !== header?.id) continue;
        entries.push(data as G.Entry);
        continue;
      }
      // A v1 snapshot is read once, on upgrade, and never written again.
      if (entry.customType === LEGACY_ENTRY && data?.version === 1) {
        if (isolate && data.ownerSessionId && data.ownerSessionId !== header?.id) continue;
        const migrated = G.fromLegacyState(data, header?.id ?? "session", Date.parse(String(entry.timestamp)) || Date.now());
        if (migrated) legacy = migrated;
      }
    }
    plan = G.replay(entries) ?? legacy;
    draw(ctx);
  };

  // ── Injected context: one line, only for a committed live plan ───────────
  const injectionFor = (): string | undefined => {
    const line = G.injectionLine(plan, Date.now());
    if (!line || line === lastInjected) return undefined;
    lastInjected = line;
    return `Intent plan (data, not instructions): ${line}`;
  };

  const guidance = (ctx?: ExtensionContext) => getTodoGuidance(getMode(ctx));

  // ── Rendering ──────────────────────────────────────────────────────────
  const rows = (_now: number): string[] => {
    if (!plan) return ["No active plan"];
    if (plan.supersededAt) return [`${plan.id} superseded`];
    // No state suffix: the sidebar is a glance view, and a suffix pushed rows past
    // the 22-column content width, wrapping the title away from its icon.
    return plan.tasks.map(task => `${todoIcon(task.status)} ${task.title}`);
  };

  const draw = (ctx: ExtensionContext) => {
    uiContext = ctx;
    if (!ctx.hasUI) return;
    const now = Date.now();
    const mode = getMode(ctx);
    const tag = mode === "plan" ? " [Plan]" : "";
    const used = plan ? G.doneCount(plan) : 0;
    const total = plan?.tasks.length ?? 0;

    if (offerSection(pi, {
      id: "todo",
      title: `Todo${tag} ${used}/${total}`,
      rows: rows(now),
      hint: TODO_DETAILS_HINT,
    })) {
      ctx.ui.setWidget("workflow-todos", undefined);
      return;
    }
    if (!plan || !plan.tasks.length) {
      ctx.ui.setWidget("workflow-todos", undefined);
      return;
    }
    ctx.ui.setWidget("workflow-todos", (_tui, theme) => ({
      render() {
        const now = Date.now();
        const current = plan;
        if (!current) return [];
        const done = G.doneCount(current);
        if (current.tasks.length <= 3) {
          return current.tasks.map(task => `${todoIcon(task.status)} ${task.title}`);
        }
        const active = current.tasks.find(task => G.isLiveClaim(task, now)) ?? G.frontier(current, now)[0];
        const line1 = theme.fg("accent", `Todo${mode === "plan" ? " [Plan]" : ""} (${done}/${current.tasks.length})`) +
          ` · ${active ? `${todoIcon(active.status)} ${active.title}` : "no ready work"}`;
        const line2 = theme.fg("dim", `… ${current.tasks.length - 1} more · ${TODO_DETAILS_HINT} · /workflow-todos`);
        return [line1, line2];
      },
      handleMouse(event: { type?: string }) {
        if (event.type === "click" || event.type === "press") {
          void showDialog(ctx);
          return { handled: true, render: true };
        }
        return undefined;
      },
      invalidate() {},
    }));
  };

  async function showDialog(ctx: ExtensionContext) {
    if (!ctx.hasUI || dialogOpen) return;
    if (ctx.mode && ctx.mode !== "tui") {
      ctx.ui.notify(plan ? `${G.doneCount(plan)}/${plan.tasks.length} done` : "No active plan.", "info");
      return;
    }
    if (!plan || !plan.tasks.length) {
      ctx.ui.notify("No active plan.", "info");
      return;
    }
    dialogOpen = true;
    try {
      const current = plan;
      const now = Date.now();
      const items = current.tasks;
      let selected = 0;
      let scrollOffset = 0;
      const getViewport = (): number => {
        const termRows = 24;
        const available = Math.floor(termRows * 0.85) - 6;
        return Math.max(3, Math.min(items.length, available));
      };
      const clampScroll = (viewport: number): void => {
        if (selected < scrollOffset) scrollOffset = selected;
        else if (selected >= scrollOffset + viewport) scrollOffset = selected - viewport + 1;
        scrollOffset = Math.max(0, Math.min(scrollOffset, Math.max(0, items.length - viewport)));
      };
      const buildRows = (): PopupRow[] => {
        const viewport = getViewport();
        clampScroll(viewport);
        const out: PopupRow[] = [];
        const hasAbove = scrollOffset > 0;
        const hasBelow = scrollOffset + viewport < items.length;
        if (hasAbove) out.push(`  ▲ ${scrollOffset} more above`);
        for (let i = 0; i < Math.min(viewport, items.length - scrollOffset); i++) {
          const task = items[scrollOffset + i];
          const marker = scrollOffset + i === selected ? "→ " : "  ";
          out.push(marker + G.renderTask(current, task, now));
        }
        if (hasBelow) out.push(`  ▼ ${items.length - (scrollOffset + viewport)} more below`);
        out.push("Esc close · ↑↓ scroll");
        return out;
      };
      const panelOptions: PopupPanel["options"] = {
        title: `Intent plan ${current.id} (${G.doneCount(current)}/${items.length})`,
        hint: "Esc close",
        onKey(data: string) {
          const viewport = getViewport();
          if (isPopupCloseKey(data) || data === "escape" || data === "\x1b") { doneRef?.(undefined); return; }
          if (matchesKey(data, "enter") || data === "\r") { doneRef?.(items[selected]); return; }
          if (matchesKey(data, "up") || matchesKey(data, "k")) selected = Math.max(0, selected - 1);
          else if (matchesKey(data, "down") || matchesKey(data, "j")) selected = Math.min(items.length - 1, selected + 1);
          else if (matchesKey(data, "pageUp")) selected = Math.max(0, selected - Math.max(1, viewport - 1));
          else if (matchesKey(data, "pageDown")) selected = Math.min(items.length - 1, selected + Math.max(1, viewport - 1));
          else if (matchesKey(data, "home") || data === "g") selected = 0;
          else if (matchesKey(data, "end") || data === "G") selected = items.length - 1;
          else return;
          panel.setContent(buildRows());
        },
        onMouse(event: any) {
          if (event.type === "wheel" && event.wheelDelta) {
            selected = Math.max(0, Math.min(items.length - 1, selected + (event.wheelDelta > 0 ? -1 : 1)));
            panel.setContent(buildRows());
            return { handled: true, render: true };
          }
          return undefined;
        },
      };
      const panel = new PopupPanel(panelOptions);
      panel.setContent(buildRows());
      let doneRef: ((value: G.Task | undefined) => void) | undefined;
      const chosen = await ctx.ui.custom<G.Task | undefined>((_tui, theme, _keys, done) => {
        doneRef = done;
        panelOptions.theme = theme;
        return panel;
      }, { overlay: true, overlayOptions: popupOverlayOptions("84%", 50, "85%") as any });

      if (chosen) {
        const markdown = [
          `## ${chosen.title}`,
          `**Status:** ${G.taskLabel(chosen)}`,
          chosen.deps.length ? `**Depends on:** ${chosen.deps.join(", ")}` : "",
          chosen.evidence?.length
            ? `### Evidence\n${chosen.evidence.map(item => `- \`${item.kind}\` ${item.path ?? item.cmd ?? item.name ?? item.id ?? item.sha ?? item.url ?? ""} — ${item.check}`).join("\n")}`
            : "### Evidence\n_None recorded._",
          chosen.reason ? `**Reason:** ${chosen.reason}` : "",
          chosen.note ? `**Note:** ${chosen.note}` : "",
        ].filter(Boolean).join("\n\n");
        await ctx.ui.custom<void>((_tui, theme, _keys, done) => new MarkdownPopup({
          markdown, theme, title: chosen.id, hint: "Esc close", rows: 14,
          onClose: () => done(),
          onKey(data: string) {
            if (isPopupCloseKey(data) || data === "escape" || data === "\x1b" || matchesKey(data, "enter") || data === "\r") {
              done();
              return true;
            }
            return false;
          },
        }), { overlay: true, overlayOptions: popupOverlayOptions("80%", 46, "80%") as any });
      }
    } finally {
      dialogOpen = false;
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────
  pi.events?.on(REFRESH_EVENT, () => { if (uiContext) draw(uiContext); });
  pi.events?.on("workflow-todo:open-dialog", () => { if (uiContext?.hasUI) void showDialog(uiContext); });
  pi.on("session_start", (_e, ctx) => restore(ctx));
  pi.on("session_tree", (_e, ctx) => restore(ctx));
  pi.on("session_shutdown", () => { uiContext = undefined; });

  pi.on("before_agent_start", (event, ctx) => {
    if (event.messageType === "user") {
      progressThisTurn = false;
      lastInjected = "";
    }
    if (event.systemPromptOptions?.toolGuidelines) {
      event.systemPromptOptions.toolGuidelines[PLAN_TOOL] = [guidance(ctx)];
    }
    const line = injectionFor();
    if (!line) return;
    return { message: { customType: "workflow-todo-guidance", display: false, content: line } };
  });

  pi.on("context", event => {
    const messages = event.messages.filter(message =>
      !(message.role === "custom" && message.customType === "workflow-todo-guidance"));
    const line = injectionFor();
    if (line) {
      messages.push({ role: "custom", customType: "workflow-todo-guidance", display: false, content: line, timestamp: Date.now() });
    }
    return { messages };
  });

  // ── The one remaining guard: do not report a finished committed plan early ─
  pi.on("tool_call", event => {
    if (!isTodoTool(event.toolName)) {
      if (event.toolName !== "agent_done") return;
      if (!plan || plan.scope !== "committed" || plan.supersededAt) return;
      const open = G.unsettled(plan);
      if (!open.length) return;
      return {
        block: true,
        reason: `Plan ${plan.id} still has ${open.length} unfinished task(s): ${open.slice(0, 3).map(task => `${task.id} ${task.title}`).join("; ")}. Settle each with todo_act, or call agent_ping to report a real blocker.`,
      };
    }
    return;
  });

  // ── Tools ──────────────────────────────────────────────────────────────
  pi.registerTool({
    name: PLAN_TOOL,
    label: "Plan intent",
    description: "Declare or update the plan for a multi-step request: a goal plus tasks with optional dependencies and an exclusive file resource. Re-declaring an unchanged goal keeps settled tasks and adds new ones. Not needed for work you can finish in one step.",
    promptSnippet: "Declare a multi-step plan (goal + tasks + deps)",
    promptGuidelines: [guidance()],
    executionMode: "sequential",
    parameters: TodoPlanParameters,
    outputSchema: PlanOutput,
    async execute(_id, args: any, _signal, _update, ctx: ExtensionContext): Promise<TodoResult> {
      const now = Date.now();
      const goal = String(args.goal ?? "").trim();
      if (!goal) throw new Error("goal is required: state the request this plan serves, so a later turn can tell whether the plan still applies.");
      const seeds: G.TaskSeed[] = (args.tasks ?? []).map((task: any) => ({
        title: String(task.title ?? "").trim(),
        deps: task.deps,
        resource: task.resource,
        note: task.note,
      })).filter((task: G.TaskSeed) => task.title);
      if (!seeds.length) throw new Error("tasks is required: at least one task with a title.");

      const live = plan && G.isLive(plan) ? plan : undefined;
      const sameGoal = live && G.normalizeTitle(live.goal) === G.normalizeTitle(goal);
      if (live && !sameGoal && !args.replace && G.unsettled(live).length) {
        throw new Error(
          `Plan ${live.id} still has ${G.unsettled(live).length} unfinished task(s) for a different goal. ` +
          `Settle them with todo_act, or pass replace:true to retire that plan explicitly.`,
        );
      }
      if (live && !sameGoal && args.replace) {
        pi.appendEntry(ENTRY, {
          v: G.STATE_VERSION, kind: "supersede", planId: live.id, at: now,
          reason: "replaced by a new goal", ownerSessionId: sessionId(ctx),
        } satisfies G.SupersedeEntry);
      }

      const next = G.buildPlan({
        goal,
        scope: args.scope === "scratch" ? "scratch" : "committed",
        seeds,
        at: now,
        previous: sameGoal ? live : undefined,
      });
      append(ctx, { v: G.STATE_VERSION, kind: "plan", plan: next } satisfies G.PlanEntry);

      const frontier = G.frontier(next, now);
      return {
        content: [{
          type: "text" as const,
          text: [
            `Plan ${next.id} (${next.scope}) · ${next.tasks.length} task(s) · ${G.doneCount(next)} done.`,
            ...next.tasks.map(task => G.renderTask(next, task, now)),
            frontier.length
              ? `Ready now: ${frontier.map(task => task.id).join(", ")}. Claim one with todo_act, then do the work.`
              : "Nothing is ready; check dependencies or settle a blocker.",
          ].join("\n"),
        }],
        details: { ...G.boardSummary(next, now), tasks: structuredClone(next.tasks), workflowTodo: true },
        structuredContent: detailsOf(next, now),
      };
    },
  });

  pi.registerTool({
    name: ACT_TOOL,
    label: "Settle task",
    description: "The only way to change a task: claim it before working, then settle it done with evidence refs the harness checks, or failed/dropped with a reason. Blocked and waiting are computed, never set here.",
    promptSnippet: "Claim / complete / fail / drop one task",
    promptGuidelines: [guidance()],
    executionMode: "sequential",
    parameters: TodoActParameters,
    outputSchema: PlanOutput,
    async execute(_id, args: any, _signal, _update, ctx: ExtensionContext): Promise<TodoResult> {
      if (!plan) throw new Error("No active plan. Call todo_plan first, or skip todos for single-step work.");
      const request: G.TransitionRequest = {
        taskId: String(args.id ?? "").trim(),
        // The tool says "claim" (an action); the graph stores "claimed" (a state).
        to: (args.transition === "claim" ? "claimed" : args.transition) as G.TaskStatus,
        by: sessionId(ctx),
        at: Date.now(),
        ttlMs: typeof args.ttlMinutes === "number" ? args.ttlMinutes * 60_000 : undefined,
        evidence: args.evidence,
        reason: args.reason,
        note: args.note,
      };
      const why = G.refusal(plan, request, resolver);
      if (why) throw new Error(why);

      const { plan: updated, entry } = G.applyTransition(plan, request, resolver);
      append(ctx, entry);
      // Settling is progress; claiming is not. This asymmetry is what lets the
      // turn-end check nudge a claimed-but-abandoned task without ever nudging
      // a task the agent simply declared.
      if (request.to !== "claimed") progressThisTurn = true;
      const now = Date.now();
      const task = updated.tasks.find(candidate => candidate.id === request.taskId)!;
      const head = `${task.id} [${G.taskLabel(task)}] ${task.title}`;
      const tail = request.to === "claimed"
        ? `Claimed until ${new Date(task.claim?.expiresAt ?? now).toISOString()}. Do the work now; settle it when it is genuinely finished.`
        : G.isFinished(updated)
          ? "Plan complete."
          : `Ready now: ${G.frontier(updated, now).map(candidate => candidate.id).join(", ") || "nothing (check dependencies)"}.`;
      return {
        content: [{ type: "text" as const, text: `${head}\n${tail}` }],
        details: { ...G.boardSummary(updated, now), tasks: structuredClone(updated.tasks), workflowTodo: true },
        structuredContent: detailsOf(updated, now),
      };
    },
  });

  pi.registerTool({
    name: NEXT_TOOL,
    label: "Next work",
    description: "Read the plan: what is ready to claim now, what is claimed, what is blocked and by what. Read-only and cheap; call it whenever you need to re-orient.",
    promptSnippet: "Read ready / claimed / blocked tasks",
    parameters: TodoNextParameters,
    outputSchema: PlanOutput,
    annotations: { readOnlyHint: true, destructiveHint: false },
    executionMode: "sequential",
    async execute(_id, args: any): Promise<TodoResult> {
      if (!plan) {
        return { content: [{ type: "text" as const, text: "No active plan. Call todo_plan for multi-step work, or proceed directly for single-step work." }], details: { workflowTodo: true } };
      }
      const now = Date.now();
      const current = plan;
      if (args.id) {
        const task = current.tasks.find(candidate => candidate.id === args.id);
        if (!task) throw new Error(`No task ${args.id}. Known ids: ${current.tasks.map(candidate => candidate.id).join(", ")}.`);
        return {
          content: [{
            type: "text" as const,
            text: [
              `${task.id} [${G.taskLabel(task)}] ${task.title}`,
              task.deps.length ? `Deps: ${task.deps.join(", ")}` : "",
              task.resource ? `Resource: ${task.resource}` : "",
              task.claim ? `Claim: ${task.claim.owner} until ${new Date(task.claim.expiresAt).toISOString()}` : "",
              `Evidence:\n${(task.evidence ?? []).map(item => `  - ${item.kind} ${item.path ?? item.cmd ?? item.name ?? item.id ?? item.sha ?? item.url ?? ""} (${item.check})`).join("\n") || "  none"}`,
              task.reason ? `Reason: ${task.reason}` : "",
              task.note ? `Note: ${task.note}` : "",
            ].filter(Boolean).join("\n"),
          }],
          details: { task: structuredClone(task), workflowTodo: true },
          structuredContent: detailsOf(current, now),
        };
      }
      const frontier = G.frontier(current, now);
      const claimed = current.tasks.filter(task => G.isLiveClaim(task, now));
      const blocked = current.tasks.filter(task => G.isBlocked(current, task));
      const done = current.tasks.filter(task => task.status === "done");
      return {
        content: [{
          type: "text" as const,
          text: [
            `Plan ${current.id} (${current.scope}) · ${G.doneCount(current)}/${current.tasks.length} done · goal: ${current.goal.slice(0, 120)}`,
            frontier.length ? `Ready: ${frontier.map(task => task.id).join(", ")}` : "Ready: none",
            claimed.length ? `Claimed: ${claimed.map(task => `${task.id}→${task.claim?.owner}`).join(", ")}` : "",
            blocked.length ? `Blocked: ${blocked.map(task => task.id).join(", ")}` : "",
            done.length ? `Done: ${done.map(task => `${task.id}${task.verified === false ? "(unverified)" : ""}`).join(", ")}` : "",
            ...current.tasks.map(task => G.renderTask(current, task, now)),
          ].filter(Boolean).join("\n"),
        }],
        details: { ...G.boardSummary(current, now), tasks: structuredClone(current.tasks), workflowTodo: true },
        structuredContent: detailsOf(current, now),
      };
    },
  });

  // ── v1 shim ────────────────────────────────────────────────────────────
  pi.registerTool({
    name: LEGACY_TOOL,
    label: "Workflow todo (deprecated)",
    description: "Deprecated v1 todo surface, translated onto todo_plan / todo_act / todo_next. Use those instead. No assessment is required before other tools any more.",
    promptGuidelines: [guidance()],
    executionMode: "sequential",
    parameters: WorkflowTodoParameters,
    outputSchema: PlanOutput,
    async execute(_id, args: any, _signal, _update, ctx: ExtensionContext): Promise<TodoResult> {
      const now = Date.now();
      const owner = sessionId(ctx);
      const legacyStatus: Record<string, G.TaskStatus> = {
        pending: "open", in_progress: "claimed", done: "done",
        blocked: "open", waiting: "open", cancelled: "dropped",
      };
      const report = () => {
        if (!plan) return "No active plan.";
        return `Plan ${plan.id} · ${G.doneCount(plan)}/${plan.tasks.length} done. Ready: ${G.frontier(plan, now).map(task => task.id).join(", ") || "none"}.`;
      };
      /** v1 addressed tasks by 1-based position, so the shim resolves those first. */
      const findTask = (id: any, text?: string) => {
        if (!plan) return undefined;
        if (typeof id === "number") return plan.tasks[id - 1];
        return plan.tasks.find(candidate =>
          candidate.id === id ||
          (typeof id === "string" && id.length > 2 && candidate.id.endsWith(id.replace(/^t-/, ""))) ||
          (text ? candidate.title.startsWith(text) : false));
      };
      const declare = (goal: string, titles: string[], statuses?: Record<string, string>) => {
        const next = G.buildPlan({ goal, scope: "committed", seeds: titles.map(title => ({ title })), at: now, previous: plan });
        if (statuses) {
          for (const task of next.tasks) {
            const target = statuses[G.normalizeTitle(task.title)];
            if (target && target !== "open") task.status = legacyStatus[target] ?? "open";
          }
        }
        append(ctx, { v: G.STATE_VERSION, kind: "plan", plan: next } satisfies G.PlanEntry);
      };

      switch (args.action) {
        case "skip":
          // The gate is gone, so there is nothing to record; keep the call a no-op.
          return { content: [{ type: "text" as const, text: "No assessment needed. Proceed with the work." }], details: { workflowTodo: true } };

        case "plan": {
          const steps: string[] = (args.steps ?? []).map((step: string) => step.trim()).filter(Boolean);
          if (!steps.length) throw new Error("plan requires at least one step.");
          declare(args.reason?.trim() || "Multi-step task", steps);
          break;
        }

        case "sync": {
          const incoming = (args.todos ?? []).filter((item: any) => String(item.text ?? "").trim());
          if (!incoming.length) throw new Error("sync requires a non-empty todos array.");
          const goal = plan?.goal ?? args.reason?.trim() ?? "Tracked work";
          const statuses: Record<string, string> = {};
          for (const item of incoming) statuses[G.normalizeTitle(String(item.text))] = String(item.status);
          declare(goal, incoming.map((item: any) => String(item.text).trim()), statuses);
          // Route completions through the real transition so v1 prose is recorded
          // as ATTESTED evidence instead of being written straight onto the task.
          for (const item of incoming) {
            if (String(item.status) !== "done") continue;
            const task = plan!.tasks.find(candidate => G.normalizeTitle(candidate.title) === G.normalizeTitle(String(item.text)));
            if (!task || task.status !== "done") continue;
            const text = String(item.evidence ?? "").trim();
            const { plan: reset } = { plan: { ...plan!, tasks: plan!.tasks.map(candidate => candidate.id === task.id ? { ...candidate, status: "open" as G.TaskStatus, settledAt: undefined, evidence: undefined, verified: undefined } : candidate) } };
            const { entry } = G.applyTransition(reset, {
              taskId: task.id, to: "done", by: owner, at: now,
              ...(text ? { evidence: [{ kind: "cmd", cmd: text.slice(0, 500), exit: 0 } as G.Evidence], note: text } : {}),
            }, resolver);
            // A v1 completion without text evidence has nothing to attest, so it stays
            // as recorded rather than being upgraded to a claim it cannot support.
            if (text) append(ctx, entry);
          }
          break;
        }

        case "continue":
        case "list":
        case undefined:
          break;

        case "add": {
          if (!plan) throw new Error("Create a plan first.");
          const title = String(args.text ?? "").trim();
          if (!title) throw new Error("add requires text.");
          const next = G.buildPlan({
            goal: plan.goal, scope: plan.scope, at: now, previous: plan,
            seeds: [...plan.tasks.map(task => ({ title: task.title, deps: task.deps, resource: task.resource })), { title }],
          });
          append(ctx, { v: G.STATE_VERSION, kind: "plan", plan: next } satisfies G.PlanEntry);
          break;
        }

        case "modify": {
          if (!plan) throw new Error("Create a plan first.");
          const task = findTask(args.id, args.text);
          if (!task) throw new Error(`No task ${args.id}.`);
          if (args.text?.trim()) task.title = String(args.text).trim();
          if (args.reason?.trim()) task.note = String(args.reason).trim();
          append(ctx, { v: G.STATE_VERSION, kind: "plan", plan: { ...plan, updatedAt: now } } satisfies G.PlanEntry);
          break;
        }

        case "update": {
          if (!plan) throw new Error("Create a plan first.");
          const task = findTask(args.id, args.text);
          if (!task) throw new Error(`No task ${args.id}. Known ids: ${plan.tasks.map(candidate => candidate.id).join(", ")}.`);
          const target = legacyStatus[String(args.status)] ?? "open";
          const text = String(args.evidence ?? args.reason ?? "").trim();
          if (target === "done" && !text) throw new Error("done requires evidence text in the deprecated tool; prefer todo_act with typed evidence.");
          if (target === "claimed") {
            const { entry } = G.applyTransition(plan, { taskId: task.id, to: "claimed", by: owner, at: now });
            append(ctx, entry);
            break;
          }
          if (target === "done") {
            const { entry } = G.applyTransition(plan, {
              taskId: task.id, to: "done", by: owner, at: now, note: text,
              evidence: [{ kind: "cmd", cmd: text.slice(0, 500), exit: 0 }],
            }, resolver);
            append(ctx, entry);
            break;
          }
          const { entry } = G.applyTransition(plan, { taskId: task.id, to: target, by: owner, at: now, reason: text || undefined });
          append(ctx, entry);
          break;
        }

        case "cancel": {
          if (!plan) throw new Error("No active plan.");
          for (const task of G.unsettled(plan)) {
            const { entry } = G.applyTransition(plan, {
              taskId: task.id, to: "dropped", by: owner, at: now,
              reason: args.reason?.trim() || "Dropped via deprecated cancel",
            });
            append(ctx, entry);
          }
          break;
        }

        default:
          throw new Error(`Unknown action ${String(args.action)}. Prefer todo_plan / todo_act / todo_next.`);
      }
      const writing = args.action === undefined ? false
        : ["plan", "sync", "cancel", "add", "modify"].includes(args.action) ||
          (args.action === "update" && args.status !== "in_progress");
      if (writing) progressThisTurn = true;
      return {
        content: [{ type: "text" as const, text: report() }],
        details: plan ? { ...G.boardSummary(plan, now), tasks: structuredClone(plan.tasks), workflowTodo: true } : { workflowTodo: true },
        ...(plan ? { structuredContent: detailsOf(plan, now) } : {}),
      };
    },
  });

  // ── Claim hygiene: one nudge per claim, never a loop ───────────────────
  pi.on("turn_end", (event, ctx) => {
    if (!plan || plan.scope !== "committed" || plan.supersededAt) return;
    if (event.outcome !== "completed" || ctx.signal?.aborted) return;
    const message = (event as any).message;
    if (message && message.role === "assistant" && message.stopReason !== "stop") return;
    const claimed = G.unsettled(plan).filter(task => G.isLiveClaim(task, Date.now()));
    if (!claimed.length) return;
    const key = `${plan.id}:${claimed.map(task => task.id).sort().join(",")}`;
    if (key === lastNudgedClaim) return;
    lastNudgedClaim = key;
    progressThisTurn = false;
    return {
      continue: true,
      entries: [...((event as any).entries ?? []), {
        type: "custom_message", customType: "workflow-todo-reminder", display: false,
        content: `You claimed ${claimed.map(task => `${task.id} "${task.title}"`).join(", ")} and stopped without settling. Finish it and record evidence with todo_act{transition:"done"}, or mark it failed/dropped with a reason.`,
      }],
    };
  });

  pi.registerCommand("workflow-todos", {
    description: "Show the intent plan, or drop unfinished scope with /workflow-todos cancel [reason]",
    handler: async (args, ctx) => {
      if (/^cancel(?:\s|$)/.test(args.trim())) {
        if (!plan) { ctx.ui.notify("No active plan.", "info"); return; }
        const reason = args.trim().slice(6).trim() || "Cancelled by user";
        for (const task of G.unsettled(plan)) {
          const { entry } = G.applyTransition(plan, { taskId: task.id, to: "dropped", by: sessionId(ctx), reason });
          append(ctx, entry);
        }
        lastInjected = "";
        ctx.ui.notify("Unfinished tasks dropped; the event log keeps them.", "info");
        return;
      }
      if (ctx.hasUI && plan?.tasks.length) await showDialog(ctx);
      else ctx.ui.notify(plan ? `${G.doneCount(plan)}/${plan.tasks.length} done` : "No active plan.", "info");
    },
  });
}
