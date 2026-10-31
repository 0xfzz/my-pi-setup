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
import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
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
import { createGate, parseRule, type AskAnswer, type AskRequest } from "../lib/scope/gate.ts";
import { effectiveBase } from "../lib/scope/cwd.ts";
import { canonicalize, classifyPath, expandHome } from "../lib/scope/paths.ts";
import { evaluateClaim, narrowYoloSensitiveRead } from "../lib/scope/policy.ts";
import {
  DEFAULT_SANDBOX_CONFIG,
} from "../lib/scope/sandbox/config.ts";
import { deriveSandboxPolicy, type SandboxBoundary, type SandboxPolicy } from "../lib/scope/sandbox/policy.ts";
import { buildSandboxEnv } from "../lib/scope/sandbox/env.ts";
import { wrapBashCommand } from "../lib/scope/sandbox/wrap.ts";
import { probeBackend, type ProbeResult } from "../lib/scope/sandbox/probe.ts";
import { RefusalDeduper, scanRefusals } from "../lib/scope/sandbox/refusal.ts";
import { accessLabel, DEFAULT_LABELS, settingsRows, type SettingsAction, type SettingsTarget } from "../lib/scope/settings.ts";
import {
  globalScopeFile,
  initialScopeState,
  loadScopeConfig,
  projectScopeFile,
  removeScopeRoot,
  removeScopeRule,
  scopeRecordFromBranch,
  scopeSnapshot,
  setScopeRootAccess,
  setScopeRuleEffect,
  writeScopeDefaults,
  writeScopeRoot,
  writeScopeRule,
} from "../lib/scope/state.ts";
import { displayPath } from "../lib/scope/tool-paths.ts";
import { formatTelemetrySummary, readTelemetryRecords, ScopeTelemetry, summarizeTelemetry } from "../lib/scope/telemetry.ts";
import { SCOPE_RECORD_TYPE, type PathClaim, type ScopeRoot, type ScopeRule, type ScopeState } from "../lib/scope/types.ts";
import { childContextState, isSubagentChildProcess, isSubagentChildSession } from "../lib/subagent-context.ts";
import { ScopeAskPopup, scopeChoices } from "../lib/ui/scope-ask.ts";
import { ScopeSettingsPopup } from "../lib/ui/scope-settings.ts";
import { offerSection, REFRESH_EVENT } from "../lib/sidebar-channel.ts";
import { planModeFromBranch } from "../lib/plan-mode.ts";

export default function scopeExtension(pi: ExtensionAPI) {
  let state: ScopeState = initialScopeState(process.cwd());
  let cwd = process.cwd();
  let context: ExtensionContext | undefined;
  let config = loadScopeConfig(cwd);
  const log = new ScopeLog();
  // The persistent half of the audit: `/scope log` is this session, this file is
  // every session, so detection and false positives can be reviewed later.
  const telemetry = new ScopeTelemetry();
  let draw: (() => void) | undefined;
  let sessionScratchDir: string | undefined;
  let sandboxDegradedWarned = false;
  const refusalDeduper = new RefusalDeduper();
  /**
   * One-shot write approvals from the refusal lane.
   *
   * "Allowed once" deliberately does not become a root: it widens exactly one
   * bash wrap, so the retry can succeed without turning a single answer into a
   * standing grant. Expiry covers a retry that never comes.
   */
  let pendingSandboxGrants: Array<{ path: string; expiresAt: number }> = [];
  /** The boundary the current bash call is judged and wrapped with. */
  let activeBoundary: SandboxBoundary | undefined;

  const SANDBOX_GRANT_TTL_MS = 2 * 60_000;

  /** Consume every pending grant: one approval covers exactly one bash call. */
  function takeSandboxGrants(): string[] {
    if (!pendingSandboxGrants.length) return [];
    const now = Date.now();
    const live = pendingSandboxGrants.filter(grant => grant.expiresAt > now).map(grant => grant.path);
    pendingSandboxGrants = [];
    return live;
  }

  function rememberSandboxGrants(paths: readonly string[]): void {
    const expiresAt = Date.now() + SANDBOX_GRANT_TTL_MS;
    for (const path of paths) {
      if (!pendingSandboxGrants.some(grant => grant.path === path)) {
        pendingSandboxGrants.push({ path, expiresAt });
      }
    }
  }

  /** The directory `/scope sandbox allow` needs in order to cover a refused path. */
  function sandboxAllowHint(path: string): string {
    const parent = dirname(path);
    return parent && parent !== "/" ? parent : path;
  }

  /** The sandbox context of the bash call just wrapped: telemetry and the
   *  refusal loop read this. `undefined` (or `degraded`) means bash ran bare,
   *  so a Permission denied in its output is not a sandbox refusal. */
  let lastSandboxMeta: { backend: string; mode: string; degraded?: boolean } | undefined;
  /** The cached probe for the current backend, so `bashAskLane` can answer
   *  synchronously without spawning on every call. */
  let knownProbe: ProbeResult | undefined;

  function bashAskRefusal(): boolean {
    const cfg = state.sandbox ?? DEFAULT_SANDBOX_CONFIG;
    if (cfg.ask !== "refusal") return false;
    const planActive = planModeFromBranch(context?.sessionManager?.getBranch?.())?.enabled === true;
    const effectiveMode = planActive ? "readonly" : cfg.mode;
    return effectiveMode !== "off" && knownProbe?.ok === true;
  }

  function getOrCreateScratchDir(): string | undefined {
    const cfg = state.sandbox ?? DEFAULT_SANDBOX_CONFIG;
    if (cfg.scratch === "off") return undefined;
    if (cfg.scratch !== "session") return cfg.scratch;
    if (!sessionScratchDir) {
      try {
        sessionScratchDir = mkdtempSync(join(tmpdir(), "pi-scope-scratch-"));
      } catch {
        sessionScratchDir = undefined;
      }
    }
    return sessionScratchDir;
  }

  function cleanupScratchDir(): void {
    if (sessionScratchDir) {
      try {
        rmSync(sessionScratchDir, { recursive: true, force: true });
      } catch {}
      sessionScratchDir = undefined;
    }
  }

  const refresh = () => pi.events?.emit(REFRESH_EVENT, {});
  const persist = () => pi.appendEntry?.(SCOPE_RECORD_TYPE, scopeSnapshot(state));

  /**
   * Pi's configured shell command prefix, read the way its own shell tool reads
   * it. A settings problem must not take the gate down: no prefix means the
   * session cwd, which is the unconfigured default anyway.
   */
  function shellPrefix(): string {
    try {
      return SettingsManager.create(cwd, getAgentDir()).getShellCommandPrefix() ?? "";
    } catch {
      return "";
    }
  }

  const gate = createGate({
    cwd: () => cwd,
    // Pi prepends the configured command prefix to every bash call, so a `cd` in
    // it moves the directory the model's relative paths actually resolve against.
    // The prefix is the same for every command, so it needs no argument.
    baseFor: () => effectiveBase(cwd, shellPrefix()),
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
    onGrant: persist,
    // "Always allow … for this workspace" writes the project config, so the next
    // session starts already granted. The session root is added by the gate
    // first, which is why a failed write still lets the call in flight through.
    onPersistGrant: grant => {
      try {
        writeScopeRoot(projectScopeFile(cwd), cwd, grant.path, grant.access);
      } catch (error) {
        context?.ui.notify(`Scope: could not write ${projectScopeFile(cwd)} — ${(error as Error).message}`, "error");
        return;
      }
      // Reload so the grant reports its real source (`project`, not `session`)
      // and `/scope status` lists the file that now carries it.
      if (context) reload(context);
    },
    // Policy the decision table cannot see. `yolo` approves ordinary outside
    // paths, never a private key or a dotenv: the arm says "stop asking about
    // paths", not "publish my credentials".
    onEvaluate: (decision, { claim }) => narrowYoloSensitiveRead(decision, claim, Boolean(state.yolo)),
    onAsk: request => {
      log.add({ tool: request.tool, path: request.display, write: request.write, outcome: "ask" });
      draw?.();
    },
    onDecision: record => telemetry.record(record),
    // The refusal lane: with an armed backend, bash pre-flight asks are
    // suppressed because the kernel is the one that asks — it refuses the
    // outside write and the refusal opens the question afterwards.
    bashAskLane: () => (bashAskRefusal() ? "refusal" : "ask"),
    sandboxBoundary: () => activeBoundary,
    sandbox: () => lastSandboxMeta,
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
      // Same list as the TUI popup: two surfaces offering different grants under
      // the same question is how an answer stops meaning what it says.
      const choices = scopeChoices(request);
      const labels = choices.map(choice => choice.label);
      const saves = choices.map(choice => choice.detail).filter((detail): detail is string => Boolean(detail));
      const chosen = await ui.select(
        `${request.write ? "write" : "read"} ${request.display}\n${request.reason}${saves.length ? `\n\n${saves.join("\n")}` : ""}`,
        labels,
      );
      const action = choices[labels.indexOf(chosen ?? "")]?.action;
      if (!action) return { kind: "deny" };
      if (action.kind === "answer") return action.answer;
      if (typeof ui.input === "function") {
        // opencode's reject-with-a-message: the note becomes the model's instruction.
        const note = await ui.input("Deny — tell the model what to do instead", "e.g. read /work/config.yaml instead");
        const feedback = note?.trim();
        return feedback ? { kind: "deny", feedback } : { kind: "deny" };
      }
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
    feedback?: string,
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
      const instruction = feedback?.trim();
      telemetry.record({
        source: "scope_answer",
        tool: "scope_answer",
        input: path,
        cwd,
        effect: "deny",
        asked: true,
        answer: instruction ? "deny-feedback" : "deny",
        reason: instruction ? "parent denied with feedback" : "parent denied",
      });
      return instruction
        ? `Recorded the parent's denial for ${classified.absolute}, so retrying it will be blocked. Do this instead: ${instruction}`
        : `Recorded the parent's denial for ${classified.absolute}. Report the blocker instead of retrying.`;
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
    telemetry.record({
      source: "scope_answer",
      tool: "scope_answer",
      input: path,
      cwd,
      effect: "allow",
      asked: true,
      answer: decision,
      reason: `parent ${decision} for ${target}`,
    });
    return `Applied the parent's ${decision}: ${target} is ${access === "ro" ? "read-only" : "read-write"} for this session. Retry the call.`;
  }

  /** The config file a settings change targets. */
  function settingsFile(target: SettingsTarget): string {
    return target === "global" ? globalScopeFile() : projectScopeFile(cwd);
  }

  function labelFor(path: string): string {
    return displayPath(cwd, path);
  }

  function sameRule(a: ScopeRule, b: ScopeRule): boolean {
    return a.action === b.action && a.resource === b.resource && a.effect === b.effect;
  }

  /**
   * Apply one change from the settings popup.
   *
   * The popup never mutates state itself: it returns an action and this function
   * does exactly what the matching `/scope …` subcommand does, so the menu and
   * the command line cannot disagree. Session changes go to the branch snapshot;
   * file changes rewrite the config and reload it.
   */
  function applySettings(action: SettingsAction, ctx: ExtensionContext): string {
    switch (action.kind) {
      case "grant-access": {
        const root = action.root;
        if (root.source === "project" || root.source === "global") {
          const file = settingsFile(root.source);
          setScopeRootAccess(file, cwd, root.path, action.access);
          reload(ctx);
          return `${labelFor(root.path)} is ${accessLabel(action.access)} in ${file}.`;
        }
        state = {
          ...state,
          roots: state.roots.map(existing => (existing.path === root.path ? { ...existing, access: action.access } : existing)),
        };
        persist();
        draw?.();
        refresh();
        return `${labelFor(root.path)} is ${accessLabel(action.access)} for this session.`;
      }
      case "grant-keep": {
        const file = projectScopeFile(cwd);
        writeScopeRoot(file, cwd, action.root.path, action.root.access);
        // Drop the session copy before saving the snapshot: the branch replay
        // upserts by path, so leaving it would make the row keep reporting
        // "session" for a grant the workspace now owns.
        state = { ...state, roots: state.roots.filter(root => root.path !== action.root.path) };
        persist();
        reload(ctx);
        return `Saved ${labelFor(action.root.path)} (${accessLabel(action.root.access)}) in ${file}; new sessions start with it.`;
      }
      case "grant-remove": {
        const root = action.root;
        if (root.source === "session" && root.path === cwd) return "The workspace grant cannot be removed.";
        if (root.source === "project" || root.source === "global") removeScopeRoot(settingsFile(root.source), cwd, root.path);
        state = { ...state, roots: state.roots.filter(existing => existing.path !== root.path) };
        persist();
        // Reload so a root lifted from a config file is really gone, not just
        // hidden in this session's copy of the state.
        reload(ctx);
        return `Removed ${labelFor(root.path)}.`;
      }
      case "rule-effect": {
        const rule = action.rule;
        const apply = (existing: ScopeRule) =>
          existing.action === rule.action && existing.resource === rule.resource ? { ...existing, effect: action.effect } : existing;
        state = { ...state, rules: state.rules.map(apply) };
        persist();
        if (rule.source === "project" || rule.source === "global") {
          const file = settingsFile(rule.source);
          setScopeRuleEffect(file, rule.action, rule.resource, action.effect);
          reload(ctx);
          return `${rule.action} ${rule.resource} is ${action.effect} in ${file}.`;
        }
        draw?.();
        refresh();
        return `${rule.action} ${rule.resource} is ${action.effect} for this session.`;
      }
      case "rule-keep": {
        const file = projectScopeFile(cwd);
        writeScopeRule(file, action.rule);
        state = { ...state, rules: state.rules.filter(existing => !sameRule(existing, action.rule)) };
        persist();
        reload(ctx);
        return `Saved the rule ${action.rule.action} ${action.rule.resource} ${action.rule.effect} in ${file}.`;
      }
      case "rule-remove": {
        const rule = action.rule;
        if (rule.source === "project" || rule.source === "global") removeScopeRule(settingsFile(rule.source), rule.action, rule.resource);
        state = { ...state, rules: state.rules.filter(existing => !sameRule(existing, rule)) };
        persist();
        reload(ctx);
        return `Removed the rule ${rule.action} ${rule.resource}.`;
      }
      case "default": {
        // Defaults are policy, not a session preference, and the branch snapshot
        // does not carry them: saving to the project config is what makes the
        // answer survive the next reload.
        const file = projectScopeFile(cwd);
        writeScopeDefaults(file, { [action.key]: action.effect });
        state = { ...state, defaults: { ...state.defaults, [action.key]: action.effect } };
        persist();
        reload(ctx);
        return `${DEFAULT_LABELS[action.key]} is now ${action.effect} (saved in ${file}).`;
      }
      case "yolo": {
        state = action.strength
          ? { ...state, yolo: { strength: action.strength, persist: true, since: Date.now() } }
          : { ...state, yolo: undefined };
        persist();
        draw?.();
        refresh();
        return action.strength
          ? `yolo ${action.strength} armed for this branch; deny rules still win.`
          : "yolo disarmed; outside paths ask again.";
      }
      case "sandbox-mode": {
        state = { ...state, sandbox: { ...(state.sandbox ?? DEFAULT_SANDBOX_CONFIG), mode: action.mode } };
        persist();
        draw?.();
        refresh();
        if (action.mode === "off") return "sandbox off; bash writes rely on parsing again.";
        return `sandbox ${action.mode} armed; an outside write is refused by the kernel and asked afterwards.`;
      }
      case "add-grant": {
        if (action.target === "session") {
          const root = addRoot(action.path, action.access, "session");
          return `${labelFor(root.path)} is ${accessLabel(action.access)} for this session.`;
        }
        const file = settingsFile(action.target);
        writeScopeRoot(file, cwd, action.path, action.access);
        reload(ctx);
        return `Saved ${action.path} (${accessLabel(action.access)}) in ${file}.`;
      }
      case "add-rule": {
        const parts = action.text.trim().split(/\s+/);
        // A one-word answer would make `parseRule` fall back to a wildcard
        // resource, which is the one thing this menu must never save by accident.
        if (parts.length < 2) throw new Error("A rule needs a resource and an effect: <tool|*> <glob> <allow|ask|deny>.");
        const rule = parseRule(action.text, ".");
        if (action.target === "session") {
          const duplicate = state.rules.some(existing => sameRule(existing, rule));
          if (!duplicate) state = { ...state, rules: [...state.rules, { ...rule, source: "session" }] };
          persist();
          draw?.();
          refresh();
          return `${rule.action} ${rule.resource} ${rule.effect} is active for this session.`;
        }
        const file = settingsFile(action.target);
        writeScopeRule(file, rule);
        reload(ctx);
        return `Saved the rule ${rule.action} ${rule.resource} ${rule.effect} in ${file}.`;
      }
    }
  }

  /** Bare `/scope` inside the TUI: the same state, as something you can edit. */
  async function openSettings(ctx: ExtensionContext) {
    await ctx.ui.custom<undefined>((tui, theme, _keys, done) => new ScopeSettingsPopup({
      view: () => ({ cwd, sources: config.sources, rows: settingsRows(state, cwd) }),
      apply: action => applySettings(action, ctx),
      theme,
      terminalRows: () => tui.terminal.rows,
      onDone: () => done(undefined),
    }), { overlay: true, overlayOptions: popupOverlayOptions("84%", 52, "88%") as never });
  }

  async function handleScope(args: string, ctx: ExtensionContext) {
    const action = parseScopeCommand(args);
    switch (action.kind) {
      case "status":
        // Bare `/scope` is the settings screen; `status` stays the copyable text
        // report, so neither surface has to guess what the user meant.
        if (!args.trim() && ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
          await openSettings(ctx);
          return;
        }
        ctx.ui.notify(
          [
            ...statusLines(state, cwd, config.sources),
            `  telemetry: ${telemetry.enabled ? telemetry.path : "off (set PI_SCOPE_TELEMETRY=on to record)"}`,
          ].join("\n"),
          "info",
        );
        return;
      case "rules":
        ctx.ui.notify(ruleLines(state).join("\n"), "info");
        return;
      case "log":
        ctx.ui.notify((action.stats ? formatStats(log.list()) : formatAudit(log.list(), action.limit)).join("\n"), "info");
        return;
      case "telemetry": {
        // Reads the global file, so the answer spans every workspace, not only this one.
        const records = readTelemetryRecords(telemetry.path, action.limit);
        ctx.ui.notify(formatTelemetrySummary(summarizeTelemetry(records), telemetry.path).join("\n"), "info");
        return;
      }
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
        if (action.target !== "session") {
          // A config root is not shadowed here: removing it from the session would
          // look like it worked and come back on the next reload.
          const file = configFileFor(action.target);
          ctx.ui.notify(
            `Scope: ${classified.absolute} is granted in ${file}. Remove that entry from the file; session removal only applies to session grants.`,
            "warning",
          );
          return;
        }
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
      case "remove-rule": {
        const label = `${action.action} ${action.resource}`;
        if (action.target !== "session") {
          const file = configFileFor(action.target);
          if (!removeScopeRule(file, action.action, action.resource)) {
            ctx.ui.notify(`Scope: ${file} has no rule ${label}.`, "warning");
            return;
          }
          reload(ctx);
          ctx.ui.notify(`Scope: removed ${label} from ${file}.`, "info");
          return;
        }
        const matches = state.rules.filter(rule => rule.action === action.action && rule.resource === action.resource);
        if (!matches.length) {
          ctx.ui.notify(`Scope: no rule matches ${label}. Try /scope rules.`, "warning");
          return;
        }
        // A rule that came from a config file cannot be revoked by editing the
        // session snapshot: say which flag does the real thing.
        const sessionOwned = matches.filter(rule => !rule.source || rule.source === "session" || rule.source === "branch");
        if (!sessionOwned.length) {
          ctx.ui.notify(
            `Scope: ${label} comes from config (${matches[0]?.source}). Revoke it with /scope remove --rule ${label} --project or --global.`,
            "warning",
          );
          return;
        }
        state = { ...state, rules: state.rules.filter(rule => !sessionOwned.includes(rule)) };
        persist();
        draw?.();
        refresh();
        ctx.ui.notify(`Scope: removed ${label} for this session.`, "info");
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
      case "sandbox": {
        const sub = action.action;
        const cfg = state.sandbox ?? DEFAULT_SANDBOX_CONFIG;
        switch (sub.kind) {
          case "status": {
            const probe = await probeBackend(cfg.backend);
            const scratch = getOrCreateScratchDir();
            const policy = deriveSandboxPolicy(state, cfg, cwd, { scratchDir: scratch });
            const lines = [
              `Sandbox status: ${cfg.mode}`,
              `  backend: ${cfg.backend} (probe: ${probe.ok ? "OK" : "FAILED — " + probe.detail})`,
              `  ask: ${cfg.ask} · retry: ${cfg.retry}`,
              `  scratch: ${scratch ?? "none"}`,
              `  writable paths (${policy.writable.length}): ${policy.writable.join(", ") || "(none)"}`,
              ...(policy.deny.length ? [`  denied paths (${policy.deny.length}): ${policy.deny.join(", ")}`] : []),
            ];
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
          case "on": {
            state = { ...state, sandbox: { ...cfg, mode: "workspace" } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify("Scope: sandbox armed in workspace mode (kernel enforces write-deny outside workspace).", "info");
            return;
          }
          case "off": {
            state = { ...state, sandbox: { ...cfg, mode: "off" } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify("Scope: sandbox disarmed.", "info");
            return;
          }
          case "mode": {
            state = { ...state, sandbox: { ...cfg, mode: sub.mode } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify(`Scope: sandbox mode set to "${sub.mode}".`, "info");
            return;
          }
          case "backend": {
            state = { ...state, sandbox: { ...cfg, backend: sub.backend } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify(`Scope: sandbox backend set to "${sub.backend}".`, "info");
            return;
          }
          case "ask": {
            state = { ...state, sandbox: { ...cfg, ask: sub.ask } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify(`Scope: sandbox ask mode set to "${sub.ask}".`, "info");
            return;
          }
          case "retry": {
            state = { ...state, sandbox: { ...cfg, retry: sub.retry } };
            persist();
            draw?.();
            refresh();
            ctx.ui.notify(`Scope: sandbox retry mode set to "${sub.retry}".`, "info");
            return;
          }
          case "probe": {
            const probe = await probeBackend(cfg.backend);
            ctx.ui.notify(`Scope sandbox probe (${probe.backend}): ${probe.ok ? "OK" : "FAILED"} — ${probe.detail}`, probe.ok ? "info" : "warning");
            return;
          }
          case "allow": {
            const path = canonicalize(resolve(cwd, expandHome(sub.path)));
            const currentAllow = cfg.allow ?? [];
            if (!currentAllow.includes(path)) {
              state = { ...state, sandbox: { ...cfg, allow: [...currentAllow, path] } };
              persist();
              draw?.();
              refresh();
            }
            ctx.ui.notify(`Scope sandbox: added writable path ${path}.`, "info");
            return;
          }
          case "deny": {
            const path = canonicalize(resolve(cwd, expandHome(sub.path)));
            const currentDeny = cfg.deny ?? [];
            if (!currentDeny.includes(path)) {
              state = { ...state, sandbox: { ...cfg, deny: [...currentDeny, path] } };
              persist();
              draw?.();
              refresh();
            }
            ctx.ui.notify(`Scope sandbox: added denied path ${path}.`, "info");
            return;
          }
          case "test": {
            const probe = await probeBackend(cfg.backend);
            const scratch = getOrCreateScratchDir();
            const policy = deriveSandboxPolicy(state, cfg, cwd, { scratchDir: scratch });
            const env = buildSandboxEnv({ scratchDir: scratch });
            const wrapped = wrapBashCommand(sub.command, policy, probe.ok ? probe.backend : "none", env);
            if ("block" in wrapped) {
              ctx.ui.notify(`Scope sandbox test BLOCKED: ${wrapped.block}`, "warning");
              return;
            }
            const lines = [
              "Scope sandbox test:",
              `  backend: ${probe.backend} (${probe.ok ? "functional" : "unavailable"})`,
              `  mode: ${policy.mode}`,
              `  command: ${wrapped.command}`,
              `  argv: ${JSON.stringify(wrapped.argv)}`,
              `  writable: ${policy.writable.join(", ")}`,
              ...(policy.deny.length ? [`  deny: ${policy.deny.join(", ")}`] : []),
            ];
            ctx.ui.notify(lines.join("\n"), "info");
            return;
          }
        }
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
      feedback: Type.Optional(
        Type.String({
          description:
            "Only for decision \"deny\": what the child should do instead. The child reads it as the instruction that replaces the refused action.",
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
      const text = applyParentDecision(params.decision, params.path, params.access ?? "rw", params.feedback);
      return { content: [{ type: "text", text }], details: { applied: true, decision: params.decision } };
    },
  });

  // ---- wiring ----------------------------------------------------------------

  /** Refresh the cached probe so `bashAskRefusal` can answer synchronously
   *  before the first bash call probes on its own. Never awaited. */
  function refreshKnownProbe(): void {
    const cfg = state.sandbox ?? DEFAULT_SANDBOX_CONFIG;
    void probeBackend(cfg.backend).then(result => {
      knownProbe = result;
    }).catch(() => {});
  }

  pi.on("session_start", (_event, ctx) => {
    reload(ctx);
    refreshKnownProbe();
    if (ctx.mode === "tui") installSidebar(ctx);
  });
  pi.on("session_tree", (_event, ctx) => {
    reload(ctx);
    refreshKnownProbe();
  });
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });

  pi.on("tool_call", async (event, ctx) => {
    context = ctx;
    const input = event.input as Record<string, unknown> | undefined;
    const command = event.toolName === "bash" && typeof input?.command === "string" ? input.command : undefined;
    const isBash = command !== undefined;
    const planActive = planModeFromBranch(context?.sessionManager?.getBranch?.())?.enabled === true;
    const cfg = state.sandbox ?? DEFAULT_SANDBOX_CONFIG;
    const effectiveMode = planActive ? "readonly" : cfg.mode;
    const effectiveCfg = { ...cfg, mode: effectiveMode };

    // Derive the write boundary before the gate judges the call. The gate must not
    // approve what the kernel is about to refuse, and a one-shot grant from the
    // refusal lane has to be visible to both halves or the retry cannot work.
    const grants = isBash ? takeSandboxGrants() : [];
    const scratch = isBash && effectiveMode !== "off" ? getOrCreateScratchDir() : undefined;
    const policy: SandboxPolicy | undefined = isBash && effectiveMode !== "off"
      ? deriveSandboxPolicy(state, effectiveCfg, cwd, { scratchDir: scratch, extraWritable: grants })
      : undefined;
    activeBoundary = policy ? { writable: policy.writable, deny: policy.deny } : undefined;

    const result = await gate.gate(event.toolName, input);
    if (result) {
      activeBoundary = undefined;
      log.add({ tool: event.toolName, path: String(input?.path ?? input?.command ?? "*"), write: true, outcome: "deny", detail: result.reason.slice(0, 80) });
      draw?.();
      return { block: true, reason: result.reason };
    }

    if (isBash) {
      if (effectiveMode === "off") {
        lastSandboxMeta = undefined;
      } else {
        const probe = await probeBackend(effectiveCfg.backend);
        lastSandboxMeta = { backend: probe.backend, mode: effectiveMode, ...(probe.ok ? {} : { degraded: true }) };
        if (!probe.ok) {
          if (!sandboxDegradedWarned) {
            sandboxDegradedWarned = true;
            ctx.ui.notify(`Scope: sandbox backend "${probe.backend}" is unavailable (${probe.detail}). Running unsandboxed.`, "warning");
          }
        } else if (policy) {
          const env = buildSandboxEnv({ scratchDir: scratch });
          const wrapped = wrapBashCommand(command, policy, probe.backend, env);
          if ("block" in wrapped) {
            log.add({ tool: "bash", path: command, write: true, outcome: "deny", detail: wrapped.block.slice(0, 80) });
            draw?.();
            return { block: true, reason: wrapped.block };
          }
          input!.command = wrapped.command;
        }
      }
    }

    return undefined;
  });

  function appendTrailer(event: { content?: Array<{ type: string; text?: string }> }, trailer: string): void {
    if (!event.content || event.content.length === 0) {
      event.content = [{ type: "text", text: trailer.trimStart() }];
      return;
    }
    const last = event.content[event.content.length - 1];
    if (last && "text" in last && typeof last.text === "string") {
      last.text += trailer;
    } else {
      event.content.push({ type: "text", text: trailer.trimStart() });
    }
  }

  pi.on("tool_result", async (event, _ctx) => {
    if (event.toolName !== "bash") return;
    // Only a call this backend actually wrapped is a sandbox refusal; a plain
    // Permission denied from an unwrapped run (degraded, or a previous
    // non-sandbox state) must not be misreported as one.
    const meta = lastSandboxMeta;
    if (!meta || meta.degraded) return;
    const effectiveMode = meta.mode;

    const text = event.content?.map(c => ("text" in c ? c.text : "")).join("\n") ?? "";
    const hits = scanRefusals(text);
    if (!hits.length) {
      const isRefusal = /Read-only file system|Permission denied|Operation not permitted|EACCES|EROFS/i.test(text);
      if (isRefusal) {
        appendTrailer(event, `\n[sandbox] blocked a write outside the workspace (sandbox mode: ${effectiveMode}).`);
      }
      return;
    }

    for (const hit of hits) {
      if (refusalDeduper.has(hit.path)) {
        // Asking again would be noise, but silence is how the loop hides: state
        // that it is still blocked and name the remedy.
        appendTrailer(
          event,
          `\n[sandbox] still blocked: ${hit.path} (already answered this session).\nWiden it with /scope sandbox allow ${sandboxAllowHint(hit.path)}.`,
        );
        continue;
      }
      refusalDeduper.add(hit.path);

      const outcome = await gate.handleRefusal("bash", hit.path);
      if (outcome.retrySafe && outcome.granted?.length) rememberSandboxGrants(outcome.granted);
      // "Retry the command" only when the approval reached the sandbox. An
      // approval the kernel never hears is the infinite-retry loop this replaced.
      const trailer = outcome.retrySafe
        ? `\n[sandbox] blocked a write outside the workspace: ${hit.path}.\nAnswer: ${outcome.grantSummary ?? "allowed"}. Retry the command.`
        : outcome.allowed
          ? `\n[sandbox] blocked a write outside the workspace: ${hit.path}.\nAnswer: ${outcome.grantSummary ?? "allowed"}, but the sandbox cannot be widened for it — a retry is refused the same way.\nWiden it with /scope sandbox allow ${sandboxAllowHint(hit.path)}.`
          : `\n[sandbox] blocked a write outside the workspace: ${hit.path}.\nAccess denied: ${outcome.reason ?? "denied by policy"}`;
      appendTrailer(event, trailer);
      draw?.();
      refresh();
    }
  });

  pi.on("session_shutdown", () => cleanupScratchDir());
  process.on("exit", () => cleanupScratchDir());

  /** One quiet rail row; the sidebar owns the layout when it is installed. */
  function installSidebar(ctx: ExtensionContext) {
    const render = () => {
      const extra = state.roots.length - 1;
      const yolo = state.yolo ? ` · YOLO(${state.yolo.strength})` : "";
      const planActive = planModeFromBranch(context?.sessionManager?.getBranch?.())?.enabled === true;
      const effectiveMode = planActive ? "readonly" : (state.sandbox?.mode ?? "off");
      const sbMode = effectiveMode !== "off"
        ? effectiveMode === "readonly" ? " · sandbox(ro)" : " · sandbox"
        : "";
      const waiting = gate.queue.size > 0 ? ` · ${gate.queue.size} waiting` : "";
      const title = `Scope${yolo}${sbMode}`;
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
