/**
 * auto-title — names a session from its own work, on the session's current model.
 *
 * After a turn settles, `lib/title/policy.ts` decides whether to write a
 * provisional title (an untitled session with a first exchange), one refinement
 * (once a plan or several turns of file work exist), or nothing. The request is
 * built from `lib/title/brief.ts`, one completion on the session's own model, and
 * the answer is cleaned by `lib/title/clean.ts`. A title is recorded on the
 * branch before it is applied, so the dashboard and the web can tell it apart
 * from a name a person chose.
 *
 * It never replaces a name a person chose. `/auto-title now [hint]`, and the web
 * action Regenerate, are the only manual paths; they ignore the cap and the lock
 * but respect the cooldown and never run while a request is in flight.
 *
 * `PI_AUTO_TITLE=0` starts the session with it off; `/auto-title on|off` flips it.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { join } from "node:path";
import { type AssistantMessage, type AssistantMessageEvent } from "@earendil-works/pi-ai/compat";
import { buildTitleBrief, hasNaturalLanguage, type TitleBrief } from "../lib/title/brief.ts";
import { titleRequest } from "../lib/title/prompt.ts";
import { cleanTitle, type TitleRejection } from "../lib/title/clean.ts";
import { AUTO_TITLE_CAP, decide, refineSignal, type PolicyEvent, type PolicyState, type SkipReason } from "../lib/title/policy.ts";
import { AUTO_TITLE_STATE_FILE, readAutoTitleFlag, writeAutoTitleFlag } from "../lib/title/flag-store.ts";
import { lengthRetryOptions, titleRequestOptions, type TitleRequestOptions } from "../lib/title/model-options.ts";
import {
  automaticAttempts,
  isGeneratedName,
  refinementTried,
  successCount,
  TITLE_ATTEMPT_ENTRY,
  TITLE_RECORD_ENTRY,
  type TitleAttempt,
  type TitleRecord,
} from "../lib/title/provenance.ts";
import {
  AUTO_TITLE_PLUGIN_ID,
  AUTO_TITLE_REGENERATE_ACTION,
  AUTO_TITLE_TOGGLE_ACTION,
  autoTitleWebView,
  type AutoTitlePhase,
} from "../lib/auto-title-web-view.ts";
import { childContextState, isSubagentChildSession } from "../lib/subagent-context.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../lib/web-plugins/actions.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";

export const AUTO_TITLE_TIMEOUT_MS = 20_000;

const REJECTION_TEXT: Record<TitleRejection, string> = {
  "empty": "the model returned no usable title",
  "keep-without-current": "the model answered KEEP with no title to keep",
  "too-few-words": "the title had too few words",
  "too-many-words": "the title had too many words",
  "generic": "the title was a generic label",
  "path": "the title contained a path",
  "url": "the title contained a URL",
  "identifier": "the title contained an identifier",
  "echo": "the title only repeated the first message",
  "not-a-title": "the title was not a meaningful name",
};

const SKIP_TEXT: Partial<Record<SkipReason, string>> = {
  busy: "a title is already being generated",
  cooldown: "a title was generated a moment ago",
  "no-exchange": "the session has no exchange to title yet",
  child: "only parent sessions are titled",
  disabled: "auto title is off",
  cap: "the automatic title limit for this session is reached",
};

function isChild(context: ExtensionContext): boolean {
  try {
    if (isSubagentChildSession(context)) return true;
    const manager = context.sessionManager as any;
    const branch = typeof manager?.getBranch === "function" ? manager.getBranch() : [];
    const header = typeof manager?.getHeader === "function" ? manager.getHeader() : undefined;
    return childContextState(branch, header, false).seeded;
  } catch {
    // If identity cannot be proven, a session must not name itself as a parent.
    return true;
  }
}

function textOf(content: readonly any[]): string {
  return content.map((block) => (block?.type === "text" && typeof block.text === "string" ? block.text : "")).join("\n");
}

async function collectReply(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessage> {
  let reply: AssistantMessage | undefined;
  for await (const event of stream) {
    if (event.type === "done") reply = event.message;
    else if (event.type === "error") reply = event.error;
  }
  if (!reply) throw new Error("the model ended without a result");
  return reply;
}

function agentDir(): string {
  try {
    return getAgentDir();
  } catch {
    return join(homedir(), ".pi", "agent");
  }
}

export default function autoTitleExtension(pi: ExtensionAPI, options: { stateFile?: string } = {}): void {
  const stateFile = options.stateFile ?? join(agentDir(), AUTO_TITLE_STATE_FILE);
  // PI_AUTO_TITLE=0 starts this process off; otherwise the stored choice decides, on by default.
  let enabled = process.env.PI_AUTO_TITLE !== "0" && (readAutoTitleFlag(stateFile) ?? true);
  let phase: AutoTitlePhase = "idle";
  let lastError: string | undefined;
  let lastManualAt: number | undefined;
  let activeCtx: ExtensionContext | undefined;
  let run: AbortController | undefined;
  const warned = new Set<string>();

  const currentName = () => pi.getSessionName()?.trim() ?? "";

  /** What the card shows about the name: who owns it, the tries so far, and the model. */
  function viewFacts(): { title?: string; source?: "auto" | "you"; attempts?: number; model?: string } {
    const name = currentName();
    const context = activeCtx;
    if (context === undefined) return { title: name || undefined };
    const sessionId = context.sessionManager.getSessionId();
    const branch = context.sessionManager.getBranch();
    return {
      title: name || undefined,
      source: name ? (isGeneratedName(branch, sessionId, name) ? "auto" : "you") : undefined,
      attempts: automaticAttempts(branch, sessionId),
      model: context.model ? `${context.model.provider}/${context.model.id}` : undefined,
    };
  }

  function publish(): void {
    publishWebView(pi, AUTO_TITLE_PLUGIN_ID, autoTitleWebView({
      enabled,
      phase,
      error: lastError,
      cap: AUTO_TITLE_CAP,
      ...viewFacts(),
    }));
  }

  function notify(context: ExtensionContext, message: string, level: "info" | "warning"): void {
    try { context.ui?.notify?.(message, level); } catch { /* a notification is a courtesy */ }
  }

  /** Automatic failures warn once per reason; a manual request always answers. */
  function reportFailure(context: ExtensionContext, trigger: PolicyEvent, reason: string): void {
    if (trigger === "manual") return notify(context, `Auto title skipped: ${reason}`, "warning");
    if (warned.has(reason)) return;
    warned.add(reason);
    notify(context, `Auto title skipped: ${reason}`, "warning");
  }

  function recordAttempt(context: ExtensionContext, attempt: Omit<TitleAttempt, "v" | "ownerSessionId">): void {
    pi.appendEntry(TITLE_ATTEMPT_ENTRY, {
      v: 1,
      ownerSessionId: context.sessionManager.getSessionId(),
      ...attempt,
    } satisfies TitleAttempt);
  }

  function stateFor(
    context: ExtensionContext,
    branch: readonly any[],
    brief: TitleBrief,
    name: string,
  ): PolicyState {
    const sessionId = context.sessionManager.getSessionId();
    // Both triggers need a substantive question and a reply to it; a manual run is no exception.
    const exchange = brief.firstUser !== "" && brief.firstAssistant !== "" && hasNaturalLanguage(brief);
    return {
      enabled,
      child: isChild(context),
      busy: run !== undefined,
      name,
      generatedName: isGeneratedName(branch, sessionId, name || undefined),
      successes: successCount(branch, sessionId),
      automaticAttempts: automaticAttempts(branch, sessionId),
      hasExchange: exchange,
      refineSignal: refineSignal(brief),
      refined: refinementTried(branch, sessionId),
      sinceManualMs: lastManualAt === undefined ? undefined : Date.now() - lastManualAt,
    };
  }

  async function requestTitle(
    context: ExtensionContext,
    options: TitleRequestOptions,
    brief: TitleBrief,
    signal: AbortSignal,
  ): Promise<AssistantMessage> {
    const model = context.model;
    if (!model) throw new Error("no model is available for this session");
    const { systemPrompt, prompt } = titleRequest(brief);
    const send = (budget: TitleRequestOptions) => collectReply(context.modelRegistry.streamSimple(
      model,
      { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
      // Reasoning is omitted (off) unless the model cannot turn it off. A one-off
      // request marked cacheRetention "none" is routed around claude-bridge's
      // prompt capture, and maxRetries 0 leaves retries to this policy.
      { maxTokens: budget.maxTokens, signal, maxRetries: 0, cacheRetention: "none", ...(budget.reasoning ? { reasoning: budget.reasoning } : {}) },
    ) as AsyncIterable<AssistantMessageEvent>);
    let reply = await send(options);
    if (reply.stopReason === "length") reply = await send(lengthRetryOptions(options));
    if (reply.stopReason === "error" || reply.stopReason === "aborted") {
      throw new Error(reply.errorMessage ?? "the model ended without a result");
    }
    // A length stop after the larger retry means mandatory reasoning outpaced the
    // budget: the leading text may still name the task. The cleaner decides — an
    // empty or unusable partial is rejected there as its named reason, not here.
    return reply;
  }

  /** One title attempt. Resolves true when a name was written. */
  async function generate(context: ExtensionContext, trigger: PolicyEvent, hint?: string): Promise<boolean> {
    const sessionId = context.sessionManager.getSessionId();
    const branch = context.sessionManager.getBranch();
    const name = currentName();
    const probe = buildTitleBrief({ branch, sessionId, cwd: context.cwd });
    const decision = decide(stateFor(context, branch, probe, name), trigger);
    if (decision.action === "skip") {
      if (trigger === "manual" && SKIP_TEXT[decision.reason]) notify(context, SKIP_TEXT[decision.reason]!, "info");
      return false;
    }
    const kind = decision.kind;
    const model = context.model;
    if (!model) {
      phase = "failed";
      lastError = "no model is available for this session";
      publish();
      reportFailure(context, trigger, lastError);
      return false;
    }
    if (kind === "manual") lastManualAt = Date.now();

    const brief = buildTitleBrief({
      branch,
      sessionId,
      cwd: context.cwd,
      currentTitle: kind === "provisional" ? undefined : name,
      refinement: kind === "refine",
      hint,
    });
    const budget = titleRequestOptions(model);
    const controller = new AbortController();
    run = controller;
    phase = "generating";
    lastError = undefined;
    publish();
    context.ui?.setStatus?.("title", "naming…");
    try {
      const reply = await requestTitle(context, budget, brief, AbortSignal.any([controller.signal, AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS)]));
      if (controller.signal.aborted) return false;
      const verdict = cleanTitle(textOf(reply.content), {
        project: context.cwd.split("/").filter(Boolean).pop(),
        firstUser: brief.firstUser,
        currentTitle: brief.currentTitle || undefined,
      });
      const source = trigger === "manual" ? "manual" : "auto";
      if (verdict.kind === "rejected") {
        throw Object.assign(new Error(REJECTION_TEXT[verdict.reason]), { attemptReason: verdict.reason });
      }
      // A person or another extension named the session while the request was in flight.
      if (currentName() !== name) {
        recordAttempt(context, { source, kind, outcome: "superseded", reason: "the name changed while the title was generated" });
        phase = "idle";
        return false;
      }
      if (verdict.kind === "keep") {
        recordAttempt(context, { source, kind, outcome: "kept", reason: "the current title still fits" });
        phase = "done";
        if (trigger === "manual") notify(context, `Session title kept: ${name}`, "info");
        return false;
      }
      // Provenance first: the rename event fires inside setSessionName, and the
      // dashboard must find this record on the branch to skip it.
      pi.appendEntry(TITLE_RECORD_ENTRY, {
        v: 1,
        ownerSessionId: sessionId,
        title: verdict.title,
        source,
        generation: successCount(branch, sessionId) + 1,
        model: `${model.provider}/${model.id}`,
        ...(reply.usage ? { usage: { input: reply.usage.input, output: reply.usage.output } } : {}),
      } satisfies TitleRecord);
      pi.setSessionName(verdict.title);
      phase = "done";
      if (trigger === "manual") notify(context, `Session title: ${verdict.title}`, "info");
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      phase = "failed";
      lastError = error instanceof Error ? error.message : String(error ?? "unknown error");
      const attemptReason = (error as { attemptReason?: string })?.attemptReason ?? "request-failed";
      recordAttempt(context, {
        source: trigger === "manual" ? "manual" : "auto",
        kind,
        outcome: "failed",
        reason: attemptReason,
      });
      reportFailure(context, trigger, lastError);
      return false;
    } finally {
      if (run === controller) run = undefined;
      context.ui?.setStatus?.("title", undefined);
      publish();
    }
  }

  function setEnabled(value: boolean): void {
    enabled = value;
    if (!value) run?.abort();
    // The choice outlives the process; a failed write still holds for this one.
    try {
      writeAutoTitleFlag(stateFile, value);
    } catch {
      // Persisting is a courtesy; the toggle itself has already taken effect.
    }
    publish();
  }

  /** Mark a generated name as the person's: the automatic path stops for this session. */
  function lock(context: ExtensionContext): void {
    const name = currentName();
    if (!name) return notify(context, "Nothing to lock: the session has no title.", "info");
    const sessionId = context.sessionManager.getSessionId();
    if (!isGeneratedName(context.sessionManager.getBranch(), sessionId, name)) {
      return notify(context, "Already yours: a name you set is never replaced automatically.", "info");
    }
    recordAttempt(context, { source: "manual", kind: "refine", outcome: "kept", reason: "locked by you" });
    publish();
    notify(context, "Title locked: automatic titles will not change it.", "info");
  }

  function statusLine(): string {
    const facts = viewFacts();
    const parts = [
      `Auto title ${enabled ? "on" : "off"}`,
      `title: ${facts.title ?? "(none)"}`,
      `source: ${facts.source === "auto" ? "generated" : facts.source === "you" ? "you" : "none"}`,
      `generations: ${facts.attempts ?? 0}/${AUTO_TITLE_CAP}`,
    ];
    if (lastError) parts.push(`last error: ${lastError}`);
    return parts.join("; ");
  }

  async function handleCommand(args: string, context: ExtensionContext): Promise<void> {
    const [word = "", ...rest] = args.trim().split(/\s+/);
    const arg = word.toLowerCase();
    if (arg === "on" || arg === "off") {
      setEnabled(arg === "on");
      context.ui.notify(`Auto title ${arg}`, "info");
    } else if (arg === "now") {
      await generate(context, "manual", rest.join(" ") || undefined);
    } else if (arg === "lock") {
      lock(context);
    } else if (arg === "" || arg === "status") {
      context.ui.notify(statusLine(), "info");
    } else {
      context.ui.notify("Usage: /title [now [hint] | on | off | lock | status]", "warning");
    }
  }

  async function onSettled(context: ExtensionContext): Promise<void> {
    activeCtx = context;
    await generate(context, "settled");
  }

  pi.on("session_start", (_event, context) => {
    activeCtx = context;
    run?.abort();
    run = undefined;
    lastError = undefined;
    lastManualAt = undefined;
    warned.clear();
    phase = currentName() ? "done" : "idle";
    // A child publishes nothing to the web: its parent owns the title.
    if (!isChild(context)) publish();
  });

  pi.on("agent_end", (_event, context) => {
    void onSettled(context);
  });

  pi.on("session_shutdown", () => {
    run?.abort();
    run = undefined;
    activeCtx = undefined;
  });

  // /title is the operator's name for this; /auto-title stays as an alias.
  for (const name of ["title", "auto-title"]) {
    pi.registerCommand(name, {
      description: "Session title: now [hint] | on | off | lock | status",
      handler: (args, context) => handleCommand(args, context),
    });
  }

  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId !== AUTO_TITLE_PLUGIN_ID || !activeCtx) return;
    if (request.actionId === AUTO_TITLE_TOGGLE_ACTION) setEnabled(!enabled);
    else if (request.actionId === AUTO_TITLE_REGENERATE_ACTION) void generate(activeCtx, "manual");
  });
}
