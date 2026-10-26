import { createLocalBashOperations, CustomEditor, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { ModeRegistry, routeSubmissions } from "../lib/modes.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";
import { recordsFromBranch as childRecords } from "../lib/subagent-state.ts";
import { childContextState, isSubagentChildSession, ownEntries } from "../lib/subagent-context.ts";
import { readOnlyShellCommand } from "../lib/plan-shell.ts";
import { INPUT_MODE_CONTEXT_TYPE, inputModeGuidance, isPlanTool, missingPlanTools, pendingPlanDeferredTools, pendingPlanExitTools, PLAN_MODE_GUIDANCE, PLAN_MODE_TYPE, planModeFromBranch } from "../lib/plan-mode.ts";
import { declaredSuperviseTools, isSupervisorTool, v2DelegationInForce, SUPERVISOR_MODE_GUIDANCE, SUPERVISOR_MODE_TYPE, superviseModeFromBranch } from "../lib/supervise-mode.ts";
import { isControlPlanePath } from "../lib/orchestrator/control-plane.ts";
import { reconcileLoadout, switchStateFromBranch } from "../lib/delegate-switch.ts";
import { DASHBOARD_SYNC_EVENT, publishDashboardMode } from "../lib/dashboard/integration.ts";

/** Derive from the UI contract so this does not depend on a re-exported alias. */
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

export default function modesExtension(pi: ExtensionAPI) {
  const registry = new ModeRegistry();
  let previousTools: string[] | undefined;
  let pendingTools = new Set<string>();
  let restoredKey: string | undefined;
  let nativeShellSubmissions = 0;
  let refresh: (() => void) | undefined;
  let draw: (() => void) | undefined;
  let installedEditor: EditorFactory | undefined;
  let baseEditor: EditorFactory | undefined;
  const isPlan = (ctx: ExtensionContext) => planModeFromBranch(policyEntries(ctx))?.enabled === true;
  const isSupervise = (ctx: ExtensionContext) => superviseModeFromBranch(policyEntries(ctx))?.enabled === true;
  const allowedPlanTool = (name: string) => isPlanTool(name, pi.getAllTools().find(tool => tool.name === name));

  /**
   * Branch-derived policy inputs for supervise mode.
   *
   * Both come from the session's own switch decision, not from the live active
   * set — that set is what this mode is in the middle of rewriting. Without the
   * `v2` flag, supervise mode leaves the v1 `subagent` tool enabled, and v1 is a
   * complete bypass of the handoff/isolation/escalation contract: no spec, no
   * lane, one shared artifact catalog, and no ladder back to the orchestrator.
   */
  /**
   * Branch-derived options for supervise mode.
   *
   * Both come from the session's own switch decision, not from the live active
   * set — that set is what this mode is in the middle of rewriting. Without the
   * `v2` flag, supervise mode leaves the v1 `subagent` tool enabled, and v1 is a
   * complete bypass of the handoff/isolation/escalation contract: no spec, no
   * lane, one shared artifact catalog, and no ladder back to the orchestrator.
   */
  const superviseOptions = (ctx: ExtensionContext) => {
    const disabled = switchStateFromBranch(policyEntries(ctx)).disabled;
    const registered = pi.getAllTools().map(tool => tool.name);
    return {
      disabledDelegates: disabled,
      v2DelegationAvailable: v2DelegationInForce(registered, disabled),
    };
  };
  const allowedSuperviseTool = (ctx: ExtensionContext, name: string) =>
    isSupervisorTool(name, pi.getAllTools().find(tool => tool.name === name), superviseOptions(ctx));
  const restrictPlanTools = () => pi.setActiveTools(pi.getAllTools()
    .filter(tool => isPlanTool(tool.name, tool) && tool.exposure !== "hidden").map(tool => tool.name));
  /**
   * Declare everything the mode permits, except tools registered as deferred.
   *
   * Withholding a `direct`-exposure tool is permanent: pi's `tool_search` only
   * indexes tools that are undeclared *because of their exposure*, so a tool this
   * function un-declares cannot be found again — not by the model, not by a
   * later turn. Session `01a16c5b` recorded thirteen `tool_search` calls asking
   * for a spawn tool the mode had just removed, and thirteen "No matching tools
   * found" replies.
   *
   * So the only thing withheld here is what this package registered with
   * `exposure: "deferred"` (`DEFERRED_ORCH_TOOLS`), which `tool_search` can
   * genuinely return. The token win lives in the review itself — one bounded
   * `orch_brief` packet instead of an ad-hoc read expedition — not in hiding the
   * instruments the loop may need.
   */
  const restrictSuperviseTools = (ctx: ExtensionContext) =>
    pi.setActiveTools(declaredSuperviseTools(pi.getAllTools(), superviseOptions(ctx)));
  /**
   * Tools that write files. Their inputs are inspected for control-plane paths —
   * the reviewer never writes, but a late-registered or MCP-provided writer still
   * reaches this hook, and the instruments of the review are not negotiable.
   */
  const MUTATING_TOOLS = new Set(["write", "edit", "multi_edit", "multiedit", "apply_patch", "applypatch", "patch"]);
  function writtenPaths(input: any): string[] {
    const out: string[] = [];
    for (const key of ["path", "file_path", "filePath"]) {
      if (typeof input?.[key] === "string") out.push(input[key]);
    }
    if (Array.isArray(input?.paths)) out.push(...input.paths.filter((value: unknown) => typeof value === "string"));
    if (Array.isArray(input?.edits)) {
      for (const edit of input.edits) if (typeof edit?.path === "string") out.push(edit.path);
    }
    return out;
  }
  function controlPlaneViolation(ctx: ExtensionContext, input: any): string | undefined {
    let sessionDir: string | null = null;
    try { sessionDir = ctx.sessionManager.getSessionDir(); } catch { sessionDir = null; }
    for (const path of writtenPaths(input)) {
      const reason = isControlPlanePath(path, { sessionDir });
      if (reason) return reason;
    }
    return undefined;
  }

  pi.events?.on(REFRESH_EVENT, () => draw?.());
  // Dashboard handshake: re-emit the branch-derived mode so an extension loaded
  // after the original transition still receives the initial state.
  pi.events?.on(DASHBOARD_SYNC_EVENT, () => publishDashboardMode(pi, registry.current.id));

  /**
   * Branch entries that define THIS session's own mode policy.
   *
   * A seeded child (`fork`) inherits its parent's entries verbatim, including any
   * `input-plan-mode:v1` records. Those name the PARENT's tool loadout and the
   * parent's spawned children, neither of which belong to the child: Pi has
   * already restored the child's own loadout from its transcript and `--tools`
   * allowlist. Only the child's own decisions apply, so an inherited snapshot can
   * never widen the child's permissions or block it over someone else's children.
   */
  function policyEntries(ctx: ExtensionContext): any[] {
    const branch = ctx.sessionManager.getBranch();
    const header = (ctx.sessionManager as any).getHeader?.();
    // Gate on `seeded` alone: the seed marker on the branch is authoritative, so
    // policy does not depend on when the child environment became visible. The
    // child flag still has to be proven, since `seeded` folds it in for legacy
    // seeds that carry a parentSession header but no marker.
    const isChild = isSubagentChildSession(ctx);
    return childContextState(branch, header, isChild).seeded ? ownEntries(branch) : branch;
  }

  function stateKey(ctx: ExtensionContext): string {
    const branch = policyEntries(ctx);
    for (let index = branch.length - 1; index >= 0; index--) {
      const entry = branch[index];
      if (entry.type === "custom" && (entry.customType === PLAN_MODE_TYPE || entry.customType === SUPERVISOR_MODE_TYPE) && typeof (entry.data as any)?.enabled === "boolean") {
        return entry.id ?? JSON.stringify([index, entry.customType, entry.data]);
      }
    }
    return "none";
  }

  function restoreTools(names: string[], ctx: ExtensionContext) {
    // A restored snapshot is a *record of the previous loadout*, not an authority
    // override. Re-apply the session's switch decision so leaving a restricted
    // mode cannot resurrect a delegate tool the user switched off while inside it.
    const disabled = switchStateFromBranch(policyEntries(ctx)).disabled;
    pi.setActiveTools(reconcileLoadout(names, disabled));
    const registered = new Set(pi.getAllTools().map(tool => tool.name));
    pendingTools = new Set(names.filter(name => !registered.has(name) && !disabled.has(name)));
  }

  function restoreConnectedTools(ctx: ExtensionContext) {
    if (!pendingTools.size) return;
    const registered = new Set(pi.getAllTools().filter(tool => tool.exposure !== "hidden").map(tool => tool.name));
    const ready = [...pendingTools].filter(name => registered.has(name));
    if (ready.length) {
      pi.setActiveTools([...new Set([...pi.getActiveTools(), ...ready])]);
      for (const name of ready) pendingTools.delete(name);
      // Persist completion so reload/tree do not resurrect an intentionally
      // deactivated tool later. Keep unresolved names across Normal requests.
      pi.appendEntry(PLAN_MODE_TYPE, { enabled: false,
        previousTools: [...new Set([...pi.getActiveTools(), ...pendingTools])], pendingTools: [...pendingTools] });
      restoredKey = stateKey(ctx);
    }
  }

  /**
   * The mode the TRANSCRIPT says this session is in.
   *
   * `registry.current` is the tab-bar cursor, not a decision: a cycle, a reload
   * or a session_tree move can leave it ahead of or behind the branch. Every
   * transition therefore starts from this value, otherwise a switch that was
   * refused or never written is indistinguishable from one that was applied.
   */
  function policyModeId(ctx: ExtensionContext): string {
    const branch = policyEntries(ctx);
    const superviseState = superviseModeFromBranch(branch);
    if (superviseState?.enabled) return superviseState.modeId === "orchestrator" ? "orchestrator" : "supervise";
    return planModeFromBranch(branch)?.enabled ? "plan" : "normal";
  }

  /** Orchestrator and Supervise are one policy behind two user-facing entries. */
  const isSupervisorMode = (id: string) => id === "supervise" || id === "orchestrator";

  function synchronize(ctx: ExtensionContext): boolean {
    const currentId = policyModeId(ctx);
    if (restoredKey === stateKey(ctx) && registry.current.id === currentId) return false;
    restore(ctx);
    return true;
  }

  function select(id: string, ctx: ExtensionContext): boolean {
    synchronize(ctx);
    if (!registry.modes.some(mode => mode.id === id)) {
      ctx.ui.notify(`Unknown mode: ${id}. Choose ${registry.modes.map(mode => mode.id).join(", ")}.`, "warning");
      return false;
    }
    // Compare against the transcript, not the cursor. Cycling used to move the
    // cursor before the policy was written, so this equality test saw the cycle
    // as already applied and skipped the transition — Plan → Orchestrator showed
    // the right tab while the tools stayed in Plan's loadout.
    const currentId = policyModeId(ctx);
    registry.select(currentId);
    // Compare against the transcript, not the cursor: a cycle moves the cursor
    // before the policy is written, so an equality test on the cursor would read
    // the transition as already applied and skip it (Plan → Orchestrator used to
    // show the right tab while the tools stayed in Plan's loadout).
    if (currentId === id) return true;
    const enteringPlan = id === "plan";
    const enteringSupervisor = isSupervisorMode(id);
    const leavingPlan = currentId === "plan";
    const leavingSupervisor = isSupervisorMode(currentId);
    const enteringRestricted = enteringPlan || enteringSupervisor;
    const leavingRestricted = leavingPlan || leavingSupervisor;
    if ((enteringRestricted || leavingRestricted) && (!ctx.isIdle() || nativeShellSubmissions > 0)) {
      ctx.ui.notify("Stop the current turn or shell command before entering or leaving restricted modes.", "warning");
      return false;
    }
    if (enteringPlan) {
      if ([...childRecords(policyEntries(ctx)).values()].some(child => !child.ended)) {
        ctx.ui.notify("Finish or stop running/unverified children before entering Plan mode. Their permissions cannot be restricted by this session.", "warning");
        return false;
      }
      if (leavingSupervisor) {
        pi.appendEntry(SUPERVISOR_MODE_TYPE, { enabled: false, modeId: currentId });
      } else {
        previousTools = [...new Set([...pi.getActiveTools(), ...pendingTools])];
        pendingTools.clear();
      }
      pi.appendEntry(PLAN_MODE_TYPE, { enabled: true, previousTools });
      restrictPlanTools();
    } else if (enteringSupervisor) {
      if (leavingPlan) {
        pi.appendEntry(PLAN_MODE_TYPE, { enabled: false });
      } else {
        previousTools = [...new Set([...pi.getActiveTools(), ...pendingTools])];
        pendingTools.clear();
      }
      // Both ids write the same entry; `modeId` remembers which tab to redraw
      // after a reload so `/mode orchestrator` does not come back as Supervise.
      pi.appendEntry(SUPERVISOR_MODE_TYPE, {
        enabled: true,
        previousTools,
        modeId: id,
      });
      restrictSuperviseTools(ctx);
    } else if (leavingRestricted) {
      restoreTools(previousTools ?? [], ctx);
      if (leavingPlan) {
        pi.appendEntry(PLAN_MODE_TYPE, { enabled: false, previousTools: previousTools ?? [], pendingTools: [...pendingTools] });
      } else {
        pi.appendEntry(SUPERVISOR_MODE_TYPE, { enabled: false, previousTools: previousTools ?? [], pendingTools: [...pendingTools], modeId: currentId });
      }
      previousTools = undefined;
    }
    registry.select(id);
    restoredKey = stateKey(ctx);
    draw?.();
    refresh?.();
    // Notification only, after the transition actually applied. A refused switch
    // returned above and therefore publishes nothing.
    publishDashboardMode(pi, id);
    return true;
  }

  /**
   * Shift+Tab and bare `/mode`: step from the transcript's mode, not the cursor.
   * A refused switch (busy turn, running children) leaves the mode untouched.
   */
  function switchToNext(ctx: ExtensionContext): void {
    const from = policyModeId(ctx);
    registry.select(from);
    select(registry.next().id, ctx);
  }

  function restore(ctx: ExtensionContext) {
    const branch = policyEntries(ctx);
    const planState = planModeFromBranch(branch);
    const superviseState = superviseModeFromBranch(branch);
    pendingTools.clear();
    if (superviseState?.enabled) {
      previousTools = superviseState.previousTools;
      registry.select(superviseState.modeId === "orchestrator" ? "orchestrator" : "supervise");
      restrictSuperviseTools(ctx);
    } else if (planState?.enabled) {
      previousTools = planState.previousTools;
      registry.select("plan");
      restrictPlanTools();
    } else {
      // Pi already restored the destination transcript before session_tree/start.
      // Never overwrite it with the outgoing branch's Plan snapshot. The sole
      // exception is an exit newer than the latest persisted system checkpoint.
      const uncheckpointed = pendingPlanExitTools(branch);
      if (uncheckpointed !== undefined) restoreTools(uncheckpointed, ctx);
      for (const name of pendingPlanDeferredTools(branch)) pendingTools.add(name);
      previousTools = undefined;
      // Plan restrictions survive reload; never silently restore a restricted snapshot.
      registry.select("normal");
    }
    restoredKey = stateKey(ctx);
    draw?.();
    refresh?.();
    // Restore is also the resume/reload path: publish the mode the transcript
    // actually resolved to, so a resumed Orchestrator session reconnects.
    publishDashboardMode(pi, registry.current.id);
  }

  pi.on("session_start", (_event, ctx) => {
    restore(ctx);
    // Surface allowlist drift once: a renamed tool would otherwise narrow Plan
    // mode silently, which looks like a policy decision rather than a bug.
    const registeredTools = typeof pi.getAllTools === "function" ? pi.getAllTools().map(tool => tool.name) : [];
    const missing = registeredTools.length ? missingPlanTools(registeredTools) : [];
    if (missing.length && ctx.hasUI) {
      ctx.ui.notify(`Plan mode allowlist references unregistered tool(s): ${missing.join(", ")}. Update lib/plan-mode.ts.`, "warning");
    }
    if (ctx.mode !== "tui") return;
    draw = () => {
      const mode = registry.current;
      if (offerSection(pi, { id: "mode", title: `${mode.icon ?? "◇"} ${mode.label}`, tone: mode.tone,
        rows: [mode.summary ?? mode.hint], hint: "Shift+Tab · switch" })) {
        ctx.ui.setWidget("input-modes", undefined);
        return;
      }
      ctx.ui.setWidget("input-modes", (_tui, theme) => ({
        render(width) {
          const tabs = registry.modes.map(mode => mode.id === registry.current.id
            ? theme.fg(mode.tone ?? "accent", theme.bold(`[ ${mode.icon ?? "◇"} ${mode.label} ]`))
            : theme.fg("dim", `  ${mode.icon ?? "◇"} ${mode.label}  `)).join(" ");
          return [truncateToWidth(`${tabs}  ${theme.fg("muted", "Shift+Tab to switch")}`, width),
            truncateToWidth(theme.fg("muted", registry.current.hint), width)];
        },
        invalidate() {},
      }));
    };
    draw();
    // The editor slot is single-occupancy: pi-paster (inline images) and
    // prompt-history both claim it. Compose over whatever is installed rather
    // than replacing it, so loading this package does not silently disable them.
    const previousEditor = typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined;
    if (previousEditor !== installedEditor) baseEditor = previousEditor;
    const createBase = baseEditor;
    installedEditor = (tui, theme, keybindings) => {
      const editor = createBase?.(tui, theme, keybindings) ?? new CustomEditor(tui, theme, keybindings);
      // Patch the instance, not the prototype: the base editor keeps its own
      // rendering, mouse handling, and every other key it already implements.
      const handleBaseInput = editor.handleInput.bind(editor);
      editor.handleInput = (data: string) => {
        // Consume before the base editor handles the built-in thinking shortcut.
        if (matchesKey(data, "shift+tab")) {
          switchToNext(ctx);
          tui.requestRender();
          return;
        }
        handleBaseInput(data);
      };
      routeSubmissions(editor, text => registry.current.route(text), (text, submit) => {
        if (!text.trimStart().startsWith("!")) return submit();
        // Observe Pi's existing async submit path rather than replace user_bash
        // operations (which would steal remote-shell handlers from extensions).
        nativeShellSubmissions++;
        try {
          const result = submit();
          if (result && typeof (result as PromiseLike<unknown>).then === "function") {
            return Promise.resolve(result).finally(() => { nativeShellSubmissions--; });
          }
          nativeShellSubmissions--;
          return result;
        } catch (error) {
          nativeShellSubmissions--;
          throw error;
        }
      });
      refresh = () => tui.requestRender();
      return editor;
    };
    ctx.ui.setEditorComponent(installedEditor);
  });

  pi.on("session_tree", (_event, ctx) => restore(ctx));

  /**
   * Re-apply the current mode's policy to whatever is registered NOW.
   *
   * MCP tool registration is inherently late and mutable: a server connects
   * lazily, advertises more tools, or drops some, all after `session_start` ran.
   * `restrictTools()` reads `getAllTools()`, so it already sees the new names — it
   * just was never called. Without this, a write-capable MCP tool that appeared
   * while Plan mode was active stayed in the active set until the NEXT prompt, so
   * the tool was selectable and surfaced as available while Plan mode refused to
   * run it. The execution guard still blocked the call, but the advertised
   * loadout and the enforced policy disagreed, which is its own bug.
   *
   * Normal mode only completes our own saved loadout. It deliberately does NOT
   * activate everything it can see: several adapters register tools with
   * `exposure: "deferred"` on purpose, to be reached through a proxy instead of
   * being declared. Force-activating those would inflate every request and
   * defeat the adapter's own exposure decision.
   */
  function reconcileTools(ctx: ExtensionContext) {
    if (isSupervise(ctx)) restrictSuperviseTools(ctx);
    else if (isPlan(ctx)) restrictPlanTools();
    else restoreConnectedTools(ctx);
  }

  // Fired when MCP servers change (lazy connect, added/removed server, refreshed
  // metadata). This is the earliest point new MCP tools exist, so the mode
  // policy is corrected here rather than being left to the next prompt.
  pi.on("mcp_servers_change", (_event, ctx) => reconcileTools(ctx));

  pi.on("before_agent_start", (event, ctx) => {
    const planActive = isPlan(ctx);
    const superviseActive = isSupervise(ctx);
    // Keep UI and AI policy on the same branch-derived state, even if a lifecycle
    // refresh was missed. Never infer mode from earlier assistant messages.
    synchronize(ctx);
    if (!planActive && !superviseActive) restoreConnectedTools(ctx);
    // Pi already falls back to the live active tools after these hooks. Do not
    // override another extension's explicit per-request selection in Normal.
    event.systemPromptOptions.sections["input_mode"] = inputModeGuidance(registry.current);
    if (superviseActive) {
      restrictSuperviseTools(ctx);
      event.systemPromptOptions.selectedTools = pi.getActiveTools().filter(name => allowedSuperviseTool(ctx, name));
      event.systemPromptOptions.sections["supervise_mode"] = SUPERVISOR_MODE_GUIDANCE;
      delete event.systemPromptOptions.sections["plan_mode"];
      return;
    }
    if (planActive) {
      restrictPlanTools();
      event.systemPromptOptions.selectedTools = pi.getActiveTools().filter(allowedPlanTool);
      event.systemPromptOptions.sections["plan_mode"] = PLAN_MODE_GUIDANCE;
      delete event.systemPromptOptions.sections["supervise_mode"];
      return;
    }
    delete event.systemPromptOptions.sections["plan_mode"];
    delete event.systemPromptOptions.sections["supervise_mode"];
  });

  // System sections are replayed as deltas and older assistant replies (or a
  // compaction summary) can still insist Plan is active. Brief the model at the
  // request boundary as well, using the SAME branch policy as the execution
  // guard. This covers tool-loop continuations, reloads and compaction, not just
  // the first request of a run. Keep it request-local: no transcript growth or
  // extra inference, and never rewrite historical user/assistant messages.
  pi.on("context", (event, ctx) => {
    synchronize(ctx);
    const messages = event.messages.filter(message =>
      !(message.role === "custom" && message.customType === INPUT_MODE_CONTEXT_TYPE));
    messages.push({
      role: "custom", customType: INPUT_MODE_CONTEXT_TYPE, display: false, timestamp: Date.now(),
      content: `<current-input-mode>\nLive mode for this request, derived from the selected branch. This supersedes historical mode instructions, assistant statements and compaction summaries; it does not grant permissions beyond the current tools and normal safety rules.\n${inputModeGuidance(registry.current)}\n</current-input-mode>`,
    });
    return { messages };
  });

  // Enforce on execution too: stale, nested, deferred and late tools still pass
  // through this guard. Read-only annotations are trusted extension/server claims.
  pi.on("tool_call", (event, ctx) => {
    const superviseActive = isSupervise(ctx);
    const planActive = isPlan(ctx);
    if (!planActive && !superviseActive) return;

    if (superviseActive) {
      if (!allowedSuperviseTool(ctx, event.toolName)) {
        return { block: true, reason: `Supervise mode: ${event.toolName} is not available to a reviewer. You do not implement: delegate the work with orch_spawn, inspect the result with orch_brief and orch_check, and record the verdict with orch_review. /mode normal to implement.` };
      }
      if (MUTATING_TOOLS.has(event.toolName)) {
        const violation = controlPlaneViolation(ctx, event.input);
        if (violation) {
          return { block: true, reason: `Supervise mode: ${violation}. Control-plane files cannot be edited: they are the review's own instruments. Use /mode normal to exit.` };
        }
      }
      if (event.toolName === "bash") {
        const command = readOnlyShellCommand(event.input?.command);
        if (command === undefined) return { block: true, reason: "Supervise mode: that shell command is not read-only, so it is refused. Use orch_brief for the diff, read/grep for the files it flags, or orch_check to run the declared verification. /mode normal to run it yourself." };
        event.input.command = command;
      }
      return;
    }

    if (planActive) {
      if (!allowedPlanTool(event.toolName)) {
        return { block: true, reason: `Plan mode: ${event.toolName} is blocked. Read-only inspection is allowed; writes are only allowed through artifact_save. Use /plan off to implement changes.` };
      }
      if (event.toolName === "bash") {
        const command = readOnlyShellCommand(event.input?.command);
        if (command === undefined) return { block: true, reason: "Plan mode: bash command is blocked (not supported read-only inspection). Use read/search tools, artifact_save for artifacts, or /plan off to implement changes." };
        // Pi 1.3 applies argument patches only through in-place mutation of
        // `event.input`; `ToolCallEventResult` has no `input` field, and the agent
        // loop executes the args it validated before the hook. Returning `{ input }`
        // silently discarded this hardening and ran the raw model text instead.
        event.input.command = command;
      }
      return;
    }
  });

  pi.on("user_bash", (event, ctx) => {
    const superviseActive = isSupervise(ctx);
    const planActive = isPlan(ctx);
    if (!planActive && !superviseActive) return;
    // The user's own shell follows the same read-only grammar: an orchestrator
    // that can run arbitrary commands is an orchestrator that can edit files.
    const command = readOnlyShellCommand(event.command);
    if (command === undefined) {
      const modeLabel = superviseActive ? "Supervise mode" : "Plan mode";
      return { result: { output: `${modeLabel} blocks shell commands that are not supported read-only inspection. Use /mode normal to make changes.`,
        exitCode: 1, cancelled: false, truncated: false } };
    }
    // user_bash cannot rewrite the input. Return local operations that execute
    // only the normalized command rather than passing raw shell text onward.
    return { operations: { exec: (_command, cwd, options) => createLocalBashOperations().exec(command, cwd, options) } };
  });

  pi.registerCommand("mode", {
    description: "Switch input mode: /mode [normal|plan|supervise|orchestrator] (or Shift+Tab)",
    getArgumentCompletions(prefix) {
      const items = registry.modes.filter(mode => mode.id.startsWith(prefix))
        .map(mode => ({ value: mode.id, label: `${mode.label} — ${mode.hint}` }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      synchronize(ctx);
      const [id, ...flags] = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
      if (ctx.mode !== "tui" && id !== "plan" && !(id === "normal" && policyModeId(ctx) === "plan")) {
        ctx.ui.notify("Input modes are available in the terminal UI only; use /plan mode or /plan off elsewhere.", "warning");
        return;
      }
      // There is exactly one orchestrator policy now; `full` was removed because
      // a widened allowlist bought implementation quality the parent should have
      // delegated, and cost independence, tokens and lane ownership in exchange.
      if (flags.length) {
        ctx.ui.notify(`Unknown option "${flags[0]}". Use /mode normal|plan|supervise|orchestrator.`, "warning");
        return;
      }
      if (id) {
        select(id, ctx);
      } else {
        switchToNext(ctx);
      }
    },
  });

  pi.registerCommand("plan", {
    description: "Read-only exploration; artifact-only writes: /plan mode (or on), /plan off, /plan status",
    getArgumentCompletions(prefix) {
      const items = ["mode", "on", "off", "status"].filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      synchronize(ctx);
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(isPlan(ctx) ? "Plan mode: read-only exploration; writes only to artifacts, no implementation." : "Plan mode is off.", "info");
      } else if (["", "mode", "on"].includes(action)) {
        if (select("plan", ctx)) ctx.ui.notify("Plan mode: read any files and use read-only tools; create/update artifacts only. /plan off to exit.", "info");
      } else if (action === "off") {
        if (select("normal", ctx)) ctx.ui.notify("Plan mode is off.", "info");
      } else {
        ctx.ui.notify("Usage: /plan mode | on | off | status", "warning");
      }
    },
  });

  pi.registerCommand("supervise", {
    description: "Orchestrator supervisor mode (no code implementation): /supervise mode (or on), /supervise off, /supervise status",
    getArgumentCompletions(prefix) {
      const items = ["mode", "on", "off", "status"].filter(value => value.startsWith(prefix))
        .map(value => ({ value, label: value }));
      return items.length ? items : null;
    },
    async handler(args, ctx) {
      synchronize(ctx);
      const action = args.trim().toLowerCase();
      if (action === "status") {
        ctx.ui.notify(isSupervise(ctx) ? "Supervise mode: orchestrator supervisor active; no direct implementation." : "Supervise mode is off.", "info");
      } else if (["", "mode", "on"].includes(action)) {
        if (select("supervise", ctx)) ctx.ui.notify("Supervise mode: orchestrate and steer subagents; direct edits and browser tools disabled. /mode normal to exit.", "info");
      } else if (action === "off") {
        if (select("normal", ctx)) ctx.ui.notify("Supervise mode is off.", "info");
      } else {
        ctx.ui.notify("Usage: /supervise mode | on | off | status", "warning");
      }
    },
  });

  pi.on("session_shutdown", () => { refresh = undefined; draw = undefined; });
}
