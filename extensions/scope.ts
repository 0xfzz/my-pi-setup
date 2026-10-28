/**
 * Workspace-by-default access scope for agent tools.
 *
 * Pi's working folder decides where tools *start*, not what they may reach: the
 * built-in `read`, `grep`, `find`, `ls` and `bash` will touch any path the
 * process can see. This extension adds the missing question: inside the
 * workspace is automatic, outside asks, and every answer is recorded.
 *
 * It is a policy, not a sandbox. `bash -c`, plugins and MCP servers can still
 * leave the workspace; `docs/scope.md` states the exact limits.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { dirname } from "node:path";
import { Type } from "typebox";
import { popupOverlayOptions } from "../lib/popup.ts";
import { formatAudit, formatStats, ScopeLog } from "../lib/scope/audit.ts";
import {
  decisionLine,
  parseScopeCommand,
  ruleLines,
  scopeCompletions,
  statusLines,
  usage,
} from "../lib/scope/command.ts";
import { createGate, type AskAnswer, type AskRequest } from "../lib/scope/gate.ts";
import { classifyPath } from "../lib/scope/paths.ts";
import { evaluateClaim } from "../lib/scope/policy.ts";
import {
  globalScopeFile,
  initialScopeState,
  loadScopeConfig,
  projectScopeFile,
  scopeRecordFromBranch,
  scopeSnapshot,
  writeScopeRoot,
  writeScopeRule,
} from "../lib/scope/state.ts";
import { SCOPE_RECORD_TYPE, type PathClaim, type ScopeRoot, type ScopeState } from "../lib/scope/types.ts";
import { childContextState, isSubagentChildProcess, isSubagentChildSession } from "../lib/subagent-context.ts";
import { ScopeAskPopup } from "../lib/ui/scope-ask.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";

export default function scopeExtension(pi: ExtensionAPI) {
  let state: ScopeState = initialScopeState(process.cwd());
  let cwd = process.cwd();
  let context: ExtensionContext | undefined;
  let config = loadScopeConfig(cwd);
  const log = new ScopeLog();
  let draw: (() => void) | undefined;

  const refresh = () => pi.events?.emit(REFRESH_EVENT, {});
  const persist = () => pi.appendEntry?.(SCOPE_RECORD_TYPE, scopeSnapshot(state));

  const gate = createGate({
    cwd: () => cwd,
    state: () => state,
    setState: next => {
      state = next;
      draw?.();
      refresh();
    },
    ask: request => askUser(request),
    // A child has nobody watching its pane: its questions go up the ladder
    // (agent_ping -> orchestrator -> agent_escalate) and come back as an answer
    // this session applies with scope_answer.
    isChild: () => isSubagentChildSession(context),
    annotationsFor: tool => pi.getAllTools?.().find(candidate => candidate.name === tool)?.annotations,
    mcpPathFields: () => config.mcpPathFields,
    onGrant: persist,
    onAsk: request => {
      log.add({ tool: request.tool, path: request.display, write: request.write, outcome: "ask" });
      draw?.();
    },
    onAutoApprove: (decision, claim) => {
      log.add({
        tool: claim?.tool ?? "unknown",
        path: claim?.absolute ?? "(undeclared paths)",
        write: claim?.write ?? true,
        outcome: "auto",
        detail: `yolo ${state.yolo?.strength ?? "ro"}`,
      });
      void decision;
      refresh();
    },
  });

  function reload(ctx: ExtensionContext) {
    context = ctx;
    cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
    const branch = ctx.sessionManager?.getBranch?.();
    // A fork-seeded child carries its parent's branch verbatim. Replaying that
    // snapshot would hand a worker every folder the orchestrator's own reading was
    // granted, plus the parent's persisted yolo arm — the opposite of "a child
    // inherits configuration, not approvals". The seed marker, not the
    // environment, decides: `modes.ts` and `subagent-checkpoints.ts` filter the
    // same way for the same reason.
    const header = (ctx.sessionManager as { getHeader?: () => unknown } | undefined)?.getHeader?.();
    const seeded = childContextState(branch, header, isSubagentChildProcess()).seeded;
    const loaded = loadScopeConfig(cwd, seeded ? undefined : scopeRecordFromBranch(branch));
    config = loaded;
    state = loaded.state;
    draw?.();
    for (const problem of loaded.problems) ctx.ui.notify(`Scope config: ${problem}`, "warning");
    if (state.yolo) {
      ctx.ui.notify(
        `Scope: yolo ${state.yolo.strength} is armed from this branch — outside paths are approved without asking. /scope yolo off disarms.`,
        "warning",
      );
    }
  }

  /**
   * Ask through whatever surface this session has.
   *
   * TUI gets the popup; RPC/print get `select`; a session with no UI at all gets
   * an explicit "unavailable" answer. Silently denying would look like a policy
   * decision and silently allowing is the hole this extension exists to close.
   */
  async function askUser(request: AskRequest): Promise<AskAnswer> {
    const ui = context?.ui;
    if (context?.mode === "tui" && typeof ui?.custom === "function") {
      const answer = await ui.custom<AskAnswer>((tui, theme, _keys, done) => new ScopeAskPopup({
        ...request,
        theme,
        terminalRows: () => tui.terminal.rows,
        onDone: done,
      }), { overlay: true, overlayOptions: popupOverlayOptions("84%", 46, "90%") as never });
      return answer ?? { kind: "deny" };
    }
    if (context?.hasUI && typeof ui?.select === "function") {
      const labels = [
        "Allow once",
        request.suggestion.exact
          ? `Allow only ${request.display} for this session`
          : `Allow ${request.suggestion.path} (${request.suggestion.access === "ro" ? "read-only" : "read-write"}) for this session`,
        "Deny",
      ];
      const chosen = await ui.select(
        `${request.write ? "write" : "read"} ${request.display}\n${request.reason}\n\nsaves ${request.suggestion.glob}`,
        labels,
      );
      if (chosen === labels[0]) return { kind: "once" };
      if (chosen === labels[1]) return { kind: "allow", grant: request.suggestion };
      return { kind: "deny" };
    }
    return {
      kind: "unavailable",
      message:
        `Scope: no dialog is available in this session, so ${request.display} was not approved. ` +
        `Grant it first with /scope allow ${request.display} (or add it to .pi/scope.json).`,
    };
  }

  // ---- /scope -----------------------------------------------------------------

  function configFileFor(target: "project" | "global"): string {
    return target === "global" ? globalScopeFile() : projectScopeFile(cwd);
  }

  function addRoot(path: string, access: "ro" | "rw", source: ScopeRoot["source"]) {
    const classified = classifyPath(cwd, state.roots, path);
    const root: ScopeRoot = { path: classified.absolute, access, source };
    const roots = state.roots.filter(existing => existing.path !== root.path);
    state = { ...state, roots: [...roots, root] };
    persist();
    draw?.();
    refresh();
    return root;
  }

  /**
   * Apply the decision a parent gave for a child's out-of-workspace path.
   *
   * The child was blocked rather than asked, so the retry only succeeds if the
   * answer lands where the gate reads it. Everything is recorded on the child's
   * own branch and in the audit, so a fork cannot inherit the grant by accident.
   */
  function applyParentDecision(
    decision: "allow-once" | "allow-folder" | "deny",
    path: string,
    access: "ro" | "rw",
  ): string {
    const classified = classifyPath(cwd, state.roots, path);
    if (decision === "deny") {
      const resource = classified.external ? classified.absolute : classified.resource;
      const rules = [
        { action: "*", resource, effect: "deny" as const, source: "session" as const },
        { action: "*", resource: `${resource.replace(/\/+$/, "")}/*`, effect: "deny" as const, source: "session" as const },
      ];
      state = { ...state, rules: [...state.rules, ...rules] };
      persist();
      draw?.();
      refresh();
      log.add({ tool: "scope_answer", path: classified.absolute, write: true, outcome: "deny", detail: "parent denied" });
      return `Recorded the parent's denial for ${classified.absolute}. Report the blocker instead of retrying.`;
    }
    const target = decision === "allow-once" ? classified.absolute : dirname(classified.absolute);
    const root: ScopeRoot = { path: target, access, source: "session" };
    state = { ...state, roots: [...state.roots.filter(existing => existing.path !== root.path), root] };
    persist();
    draw?.();
    refresh();
    log.add({
      tool: "scope_answer",
      path: target,
      write: access === "rw",
      outcome: "auto",
      detail: `parent ${decision}`,
    });
    return `Applied the parent's ${decision}: ${target} is ${access === "ro" ? "read-only" : "read-write"} for this session. Retry the call.`;
  }

  function handleScope(args: string, ctx: ExtensionContext) {
    const action = parseScopeCommand(args);
    switch (action.kind) {
      case "status":
        ctx.ui.notify(statusLines(state, cwd, config.sources).join("\n"), "info");
        return;
      case "rules":
        ctx.ui.notify(ruleLines(state).join("\n"), "info");
        return;
      case "log":
        ctx.ui.notify((action.stats ? formatStats(log.list()) : formatAudit(log.list(), action.limit)).join("\n"), "info");
        return;
      case "allow": {
        if (action.target === "session") {
          const root = addRoot(action.path, action.access, "session");
          ctx.ui.notify(`Scope: ${root.path} is ${action.access === "ro" ? "read-only" : "read-write"} for this session.`, "info");
          return;
        }
        const file = configFileFor(action.target);
        writeScopeRoot(file, cwd, action.path, action.access);
        reload(ctx);
        ctx.ui.notify(`Scope: added ${action.path} (${action.access}) to ${file}.`, "info");
        return;
      }
      case "deny": {
        const classified = classifyPath(cwd, state.roots, action.path);
        const resource = classified.external ? classified.absolute : classified.resource;
        // Two rules, not one: denying a directory must also deny what is inside
        // it, and `path` alone never matches `path/child` under opencode-style
        // glob semantics. The exact rule still protects the directory itself.
        const rules = [
          { action: "*", resource, effect: "deny" as const },
          { action: "*", resource: `${resource.replace(/\/+$/, "")}/*`, effect: "deny" as const },
        ];
        if (action.target === "session") {
          const known = new Set(state.rules.map(rule => `${rule.action} ${rule.resource} ${rule.effect}`));
          const added = rules.filter(rule => !known.has(`${rule.action} ${rule.resource} ${rule.effect}`));
          state = { ...state, rules: [...state.rules, ...added] };
          persist();
          draw?.();
          refresh();
          ctx.ui.notify(`Scope: denied ${resource} and everything under it for this session.`, "warning");
          return;
        }
        const file = configFileFor(action.target);
        for (const rule of rules) writeScopeRule(file, rule);
        reload(ctx);
        ctx.ui.notify(`Scope: wrote deny rules for ${resource} to ${file}.`, "warning");
        return;
      }
      case "remove": {
        const classified = classifyPath(cwd, state.roots, action.path);
        const before = state.roots.length;
        state = { ...state, roots: state.roots.filter(root => root.path !== classified.absolute) };
        if (state.roots.length === before) {
          ctx.ui.notify(`Scope: no session root matches ${action.path}.`, "warning");
          return;
        }
        persist();
        draw?.();
        refresh();
        ctx.ui.notify(`Scope: removed ${classified.absolute}.`, "info");
        return;
      }
      case "reset": {
        state = { ...state, roots: state.roots.filter(root => root.source !== "session"), rules: state.rules.filter(rule => rule.source !== "session" && rule.source !== "branch") };
        persist();
        draw?.();
        refresh();
        ctx.ui.notify("Scope: session grants and rules cleared; workspace and config roots remain.", "info");
        return;
      }
      case "test": {
        const classified = classifyPath(cwd, state.roots, action.path);
        const lines = (["read", "write"] as const).map(mode => {
          const claim: PathClaim = {
            tool: mode === "write" ? "write" : "read",
            action: mode === "write" ? "write" : "read",
            absolute: classified.absolute,
            resource: classified.resource,
            write: mode === "write",
            posture: mode === "write" ? "write" : "read",
            external: classified.external,
            kind: "unknown",
          };
          return `${mode}: ${decisionLine(evaluateClaim(claim, state))}`;
        });
        ctx.ui.notify([`Scope test: ${classified.absolute}`, ...lines].join("\n"), "info");
        return;
      }
      case "yolo": {
        if (action.mode === "status") {
          ctx.ui.notify(state.yolo
            ? `Scope: yolo ${state.yolo.strength}${state.yolo.persist ? " (persisted)" : ""}. /scope yolo off disarms.`
            : "Scope: yolo is off.", "info");
          return;
        }
        if (action.mode === "off") {
          state = { ...state, yolo: undefined };
          persist();
          draw?.();
          refresh();
          ctx.ui.notify("Scope: yolo disarmed; outside paths ask again.", "info");
          return;
        }
        const strength = action.mode === "all" ? "rw" : "ro";
        state = { ...state, yolo: { strength, persist: action.persist, since: Date.now() } };
        if (action.persist) persist();
        draw?.();
        refresh();
        ctx.ui.notify(
          `Scope: yolo ${strength} armed — ${strength === "ro" ? "reads outside the workspace" : "reads and writes outside the workspace"} run without asking. Deny rules still apply. /scope yolo off disarms.`,
          "warning",
        );
        return;
      }
      default:
        ctx.ui.notify(usage(action.kind === "usage" ? action.detail : ""), "warning");
    }
  }

  pi.registerCommand?.("scope", {
    description: "Workspace access scope: /scope status|allow|deny|remove|reset|rules|test|yolo|log",
    getArgumentCompletions: (prefix: string) => scopeCompletions(prefix),
    handler: async (args: string, ctx: ExtensionContext) => handleScope(args ?? "", ctx),
  });

  // ---- scope_answer ------------------------------------------------------------

  /**
   * The child half of the escalation ladder.
   *
   * `gate.ts` blocks instead of opening a dialog in a child, and the block message
   * tells the child to `agent_ping` its parent. This is where the answer lands:
   * a decision, applied to this session only, so the retry is judged by the same
   * policy as everything else.
   */
  pi.registerTool?.({
    name: "scope_answer",
    label: "Apply a parent's scope decision",
    description:
      "Apply the allow/deny decision your parent gave for a path outside the workspace. " +
      "Call it after agent_ping returns an answer; it makes the retry succeed, or records the denial so you stop asking.",
    parameters: Type.Object({
      decision: Type.Union([
        Type.Literal("allow-once", { description: "Approve this one path." }),
        Type.Literal("allow-folder", { description: "Approve the directory that contains it." }),
        Type.Literal("deny", { description: "Refuse it and record the refusal." }),
      ]),
      path: Type.String({ description: "The absolute path the parent decided about." }),
      access: Type.Optional(
        Type.Union([Type.Literal("ro"), Type.Literal("rw")], {
          description: "Read-only or read-write. Defaults to read-write, matching the blocked call.",
        }),
      ),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    async execute(_id, params) {
      if (!isSubagentChildSession(context)) {
        return {
          content: [{ type: "text", text: "scope_answer applies only inside a delegated child session; a parent has its own dialog." }],
          details: { applied: false, decision: params.decision },
        };
      }
      const text = applyParentDecision(params.decision, params.path, params.access ?? "rw");
      return { content: [{ type: "text", text }], details: { applied: true, decision: params.decision } };
    },
  });

  // ---- wiring ----------------------------------------------------------------

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    if (ctx.mode === "tui") installSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => reload(ctx));
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });

  pi.on("tool_call", async (event, ctx) => {
    context = ctx;
    const input = event.input as Record<string, unknown> | undefined;
    const result = await gate.gate(event.toolName, input);
    if (!result) return undefined;
    log.add({ tool: event.toolName, path: String(input?.path ?? input?.command ?? "*"), write: true, outcome: "deny", detail: result.reason.slice(0, 80) });
    draw?.();
    return { block: true, reason: result.reason };
  });

  /** One quiet rail row; the sidebar owns the layout when it is installed. */
  function installSidebar(ctx: ExtensionContext) {
    const render = () => {
      const extra = state.roots.length - 1;
      const yolo = state.yolo ? ` · YOLO(${state.yolo.strength})` : "";
      const waiting = gate.queue.size > 0 ? ` · ${gate.queue.size} waiting` : "";
      const title = `Scope${yolo}`;
      const rows = [`workspace${extra > 0 ? ` +${extra}` : ""}${waiting}`];
      if (offerSection(pi, { id: "scope", title, tone: state.yolo ? "warning" : "accent", rows, hint: "Alt+W → S · details" })) {
        ctx.ui.setWidget("scope", undefined);
        return;
      }
      ctx.ui.setWidget("scope", (_tui, theme) => ({
        render(width) {
          const line = `${theme.fg(state.yolo ? "warning" : "accent", title)}  ${theme.fg("dim", rows[0]!)}`;
          return [line.slice(0, Math.max(0, width))];
        },
        invalidate() {},
      }));
    };
    draw = render;
    render();
  }
}
