/**
 * auto-title — names an untitled session from its first exchange.
 *
 * After a turn ends, if the session has no name, one short completion on the
 * session's current model turns the first user message and first assistant
 * reply into a 3–6 word title (see lib/auto-title.ts) and applies it with
 * `setSessionName`, so Pi's picker, the dashboard and the web all show it.
 *
 * It only fills an empty slot: a name from `/name`, `session_goal` or an earlier
 * run is never replaced by the automatic path. The explicit `/auto-title now`
 * command and the web "Regenerate" action are the only ways to replace a name,
 * and a failure leaves the name as it was.
 *
 * `PI_AUTO_TITLE=0` starts the session with it off; `/auto-title on|off` flips it.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { generateAutoTitle } from "../lib/auto-title.ts";
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

/** Automatic tries per session. A failed try is retried once on a later turn, then left alone. */
export const AUTO_TITLE_ATTEMPTS = 2;
export const AUTO_TITLE_TIMEOUT_MS = 20_000;

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

export default function autoTitleExtension(pi: ExtensionAPI): void {
  let enabled = process.env.PI_AUTO_TITLE !== "0";
  let phase: AutoTitlePhase = "idle";
  let lastError: string | undefined;
  let activeCtx: ExtensionContext | undefined;
  let run: AbortController | undefined;
  const attempts = new Map<string, number>();

  const currentName = () => pi.getSessionName()?.trim() ?? "";

  function publish(): void {
    publishWebView(pi, AUTO_TITLE_PLUGIN_ID, autoTitleWebView({
      enabled,
      phase,
      title: currentName() || undefined,
      error: lastError,
    }));
  }

  /** One completion on the session's own model. Resolves true when a name was applied. */
  async function generate(context: ExtensionContext, mode: "auto" | "forced"): Promise<boolean> {
    const model = context.model;
    if (!model || run) return false;
    const sessionId = context.sessionManager.getSessionId();
    const controller = new AbortController();
    run = controller;
    phase = "generating";
    lastError = undefined;
    publish();
    try {
      const title = await generateAutoTitle({
        branch: context.sessionManager.getBranch(),
        project: context.cwd.split("/").filter(Boolean).pop(),
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(AUTO_TITLE_TIMEOUT_MS)]),
        async complete({ systemPrompt, prompt, maxTokens, signal }) {
          const reply = await context.modelRegistry.complete(
            model,
            { systemPrompt, messages: [{ role: "user", content: prompt, timestamp: Date.now() }] },
            { maxTokens, signal } as never,
          );
          if (reply.stopReason === "error" || reply.stopReason === "aborted") {
            throw new Error(reply.errorMessage ?? `model reply ${reply.stopReason}`);
          }
          return reply.content.map((block) => (block.type === "text" ? block.text : "")).join("\n");
        },
      });
      if (controller.signal.aborted) return false;
      if (!title) throw new Error("the model returned no usable title");
      // The user or the agent may have named the session while the request was in flight.
      if (mode === "auto" && currentName()) {
        phase = "idle";
        return false;
      }
      pi.setSessionName(title);
      phase = "done";
      return true;
    } catch (error) {
      if (controller.signal.aborted) return false;
      phase = "failed";
      lastError = error instanceof Error ? error.message : String(error ?? "unknown error");
      try {
        context.ui?.notify?.(`Auto title skipped: ${lastError}`, "warning");
      } catch {
        // A notification is a courtesy; a title failure never disturbs the session.
      }
      return false;
    } finally {
      if (run === controller) run = undefined;
      if (mode === "auto" && sessionId) attempts.set(sessionId, (attempts.get(sessionId) ?? 0) + 1);
      publish();
    }
  }

  async function onTurnEnd(context: ExtensionContext): Promise<void> {
    activeCtx = context;
    if (!enabled || run || isChild(context) || currentName()) return;
    const sessionId = context.sessionManager.getSessionId();
    if ((attempts.get(sessionId) ?? 0) >= AUTO_TITLE_ATTEMPTS) return;
    await generate(context, "auto");
  }

  function setEnabled(value: boolean): void {
    enabled = value;
    if (!value) run?.abort();
    publish();
  }

  function regenerate(context: ExtensionContext): void {
    if (isChild(context)) return;
    void generate(context, "forced");
  }

  pi.on("session_start", (_event, context) => {
    activeCtx = context;
    run?.abort();
    run = undefined;
    phase = currentName() ? "done" : "idle";
    lastError = undefined;
    if (!isChild(context)) publish();
  });

  pi.on("agent_end", (_event, context) => {
    void onTurnEnd(context);
  });

  pi.on("session_shutdown", () => {
    run?.abort();
    run = undefined;
    activeCtx = undefined;
  });

  pi.registerCommand("auto-title", {
    description: "Auto session title: now | on | off | status",
    handler: async (args, context) => {
      const arg = args.trim().toLowerCase();
      if (arg === "on" || arg === "off") {
        setEnabled(arg === "on");
        context.ui.notify(`Auto title ${arg}`, "info");
      } else if (arg === "now") {
        if (isChild(context)) return context.ui.notify("Only parent sessions are auto-titled.", "warning");
        if (await generate(context, "forced")) context.ui.notify(`Session title: ${currentName()}`, "info");
      } else if (arg === "" || arg === "status") {
        context.ui.notify(`Auto title ${enabled ? "on" : "off"}; title: ${currentName() || "(none)"}`, "info");
      } else {
        context.ui.notify("Usage: /auto-title now | on | off | status", "warning");
      }
    },
  });

  pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, (data: unknown) => {
    const request = data as Partial<ActionRequestPayload> | undefined;
    if (request?.pluginId !== AUTO_TITLE_PLUGIN_ID || !activeCtx) return;
    if (request.actionId === AUTO_TITLE_TOGGLE_ACTION) setEnabled(!enabled);
    else if (request.actionId === AUTO_TITLE_REGENERATE_ACTION) regenerate(activeCtx);
  });
}
