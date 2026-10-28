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
import { popupOverlayOptions } from "../lib/popup.ts";
import { createGate, type AskAnswer, type AskRequest } from "../lib/scope/gate.ts";
import {
  initialScopeState,
  loadScopeConfig,
  scopeRecordFromBranch,
  scopeSnapshot,
} from "../lib/scope/state.ts";
import { SCOPE_RECORD_TYPE, type ScopeState } from "../lib/scope/types.ts";
import { ScopeAskPopup } from "../lib/ui/scope-ask.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";

export default function scopeExtension(pi: ExtensionAPI) {
  let state: ScopeState = initialScopeState(process.cwd());
  let cwd = process.cwd();
  let context: ExtensionContext | undefined;
  let problems: string[] = [];
  let config = loadScopeConfig(cwd);
  let draw: (() => void) | undefined;

  const refresh = () => pi.events?.emit(REFRESH_EVENT, {});

  const gate = createGate({
    cwd: () => cwd,
    state: () => state,
    setState: next => {
      state = next;
      draw?.();
      refresh();
    },
    ask: request => askUser(request),
    annotationsFor: tool => pi.getAllTools?.().find(candidate => candidate.name === tool)?.annotations,
    mcpPathFields: () => config.mcpPathFields,
    onGrant: () => {
      // A full snapshot, not a delta: replaying it (resume, fork) is idempotent.
      pi.appendEntry?.(SCOPE_RECORD_TYPE, scopeSnapshot(state));
    },
  });

  function reload(ctx: ExtensionContext) {
    context = ctx;
    cwd = ctx.sessionManager?.getCwd?.() ?? process.cwd();
    const records = scopeRecordFromBranch(ctx.sessionManager?.getBranch?.());
    const loaded = loadScopeConfig(cwd, records);
    config = loaded;
    state = loaded.state;
    problems = loaded.problems;
    draw?.();
    for (const problem of problems) ctx.ui.notify(`Scope config: ${problem}`, "warning");
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

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    if (ctx.mode === "tui") installSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => reload(ctx));
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });

  pi.on("tool_call", async (event, ctx) => {
    context = ctx;
    const result = await gate.gate(event.toolName, event.input as Record<string, unknown> | undefined);
    return result ? { block: true, reason: result.reason } : undefined;
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
