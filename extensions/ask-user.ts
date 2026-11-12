import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubagentChildSession } from "../lib/subagent-context.ts";
import { AskUserPopup, type AskAnswer } from "../lib/ui/ask.ts";
import { overlayRows, popupOverlayOptions } from "../lib/popup/frame.ts";
import { WEB_PLUGIN_ACTION_REQUEST_EVENT, type ActionRequestPayload } from "../lib/web-plugins/actions.ts";
import { publishWebView } from "../lib/web-plugins/publisher.ts";
import type { DialogAction } from "../lib/web-plugins/view.ts";

type AskResult = {
  status: "answered" | "cancelled" | "forwarded" | "unavailable";
  question: string;
  answer?: string;
  message?: string;
  answeredWith?: "option" | "text";
  matchedOption?: string;
};

const parentGuidance =
  "A Herdr child is waiting on you. Answer from reliable known context if possible. " +
  "Otherwise ask the user with ask_user. Resume that child with agent_resume using the supplied session path and the answer. " +
  "Cancellation is unanswered, never consent: report that explicitly when resuming; do not invent an answer.";
const childGuidance =
  "In a Herdr child (PI_SUBAGENT_SESSION), never open user UI. Prefer calling agent_ping directly with your question, context, and options. " +
  "agent_ping notifies the parent and shuts down this child until the parent uses agent_resume; " +
  "direct invocation avoids nested-tool shutdown interrupting ask_user's result. ask_user forwards through the same protocol, not a synchronous answer. " +
  "If forwarding is unavailable or denied, report the blocker; never fall back to user UI.";

function result(details: AskResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
    ...(details.status === "unavailable" ? { isError: true } : {}),
  };
}

type AskToolResult = ReturnType<typeof result>;

export default function askUser(pi: ExtensionAPI) {
  // A context message composes with other extensions without replacing their prompt
  // or maintaining branch-sensitive state. This API has no prompt-options result.
  //
  // Injected only when a run actually needs it. Emitting the parent guidance on
  // every turn made it read as a standing assignment: a bare "test" arrived with
  // a hidden instruction about answering pings and resuming children, so a trivial
  // prompt turned into a protocol recital. A ping is itself a custom message that
  // starts its own run, so gating on that costs nothing and keeps ordinary prompts
  // clean. Children always get their guidance: it constrains tools they can reach
  // at any moment.
  pi.on("before_agent_start", async (event, ctx) => {
    // Proven child identity, not an inherited env var: a plain `pi` started from a
    // Herdr pane's shell used to be told it was a child and to answer its parent.
    if (isSubagentChildSession(ctx)) {
      return { message: { customType: "ask-user-guidance", content: childGuidance, display: false } };
    }
    const customType = event.messageType === "custom" ? event.message.customType : undefined;
    if (customType !== "subagent_ping") return;
    return { message: { customType: "ask-user-guidance", content: parentGuidance, display: false } };
  });

  /**
   * The web surface for ask_user: render the question as a plugin dialog whose
   * option actions round-trip through the plugin action pipeline, then resolve
   * the awaited answer. Free-text questions have no web input yet, so they
   * report unavailable and let the model re-ask with options.
   */
  const ASK_WEB_PLUGIN_ID = "ask-user";

  async function askInWeb(
    question: string,
    context: string | undefined,
    options: string[] | undefined,
    recommended: number | undefined,
    signal: AbortSignal | undefined,
  ): Promise<AskToolResult> {
    if (options === undefined || options.length === 0) {
      return result({
        status: "unavailable", question,
        message: "Unanswered: the web client has no free-text input. Ask again with `options` so the choices render as dialog actions.",
      });
    }

    const cancelled = () => result({
      status: "cancelled", question,
      message: "Unanswered. No consent or approval was given.",
    });

    const choices = options;

    // Encode the choice plus a per-question nonce into each action id so a late
    // or duplicated action request can only resolve its own question.
    const nonce = Math.random().toString(36).slice(2, 10);
    const actions: DialogAction[] = [
      ...choices.map((option, index) => ({
        id: `opt-${nonce}-${index}`,
        label: option,
        ...(recommended === index + 1 ? { tone: "primary" as const } : {}),
      })),
      { id: `cancel-${nonce}`, label: "Cancel" },
    ];

    return new Promise<AskToolResult>((resolve) => {
      let settled = false;
      let unsubscribe = () => {};
      function finish(value: AskToolResult) {
        if (settled) return;
        settled = true;
        unsubscribe();
        signal?.removeEventListener("abort", onAbort);
        void publishWebView(pi, ASK_WEB_PLUGIN_ID, { type: "dialog", open: false });
        resolve(value);
      }
      function onAbort() {
        finish(cancelled());
      }
      function onAction(data: unknown) {
        const request = data as Partial<ActionRequestPayload> | undefined;
        if (request?.pluginId !== ASK_WEB_PLUGIN_ID) return;
        const actionId = typeof request.actionId === "string" ? request.actionId : "";
        if (actionId === `cancel-${nonce}`) {
          finish(cancelled());
          return;
        }
        const match = /^opt-([a-z0-9]+)-([0-9]+)$/.exec(actionId);
        if (match?.[1] !== nonce) return;
        const answer = choices[Number(match[2])];
        if (answer === undefined) return;
        finish(result({
          status: "answered",
          question,
          answer: answer.trim(),
          answeredWith: "option",
          matchedOption: answer.trim(),
        }));
      }
      unsubscribe = pi.events?.on(WEB_PLUGIN_ACTION_REQUEST_EVENT, onAction) ?? (() => {});
      if (signal?.aborted) {
        finish(cancelled());
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
      publishWebView(pi, ASK_WEB_PLUGIN_ID, {
        type: "dialog",
        title: question,
        ...(context !== undefined ? { body: context } : {}),
        actions,
        open: true,
      });
    });
  }

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask one question and wait for a user answer, optionally offering exact choices. " +
      "A cancelled dialog is unanswered, never approval. In Herdr children this forwards to the parent and exits, not a synchronous user answer.",
    exposure: "model-only",
    executionMode: "sequential",
    reachesTools: () => ["agent_ping"],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "The single question to ask." }),
      context: Type.Optional(Type.String({ description: "Brief context needed to answer." })),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
        description: "Exact choices; omit for a free-text answer.",
      })),
      recommended: Type.Optional(Type.Integer({
        minimum: 1,
        description: "1-based option number to mark as the recommended answer. It is only a label; the user must still choose.",
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { question, context, options, recommended } = params;
      const cancelled = () => result({
        status: "cancelled", question,
        message: "Unanswered. No consent or approval was given.",
      });
      if (signal?.aborted) return cancelled();
      if (!question.trim()) {
        return result({ status: "unavailable", question, message: "Provide a non-empty question." });
      }
      if (recommended !== undefined && (!options?.length || !Number.isInteger(recommended) || recommended < 1 || recommended > options.length)) {
        return result({
          status: "unavailable", question,
          message: "recommended must be a 1-based option number within the supplied options.",
        });
      }

      if (isSubagentChildSession(ctx)) {
        const unavailable = (reason: string) => result({
          status: "unavailable", question,
          message: `Unanswered: ${reason}. Ensure the Herdr agent_ping tool is loaded and permitted in this child, then call agent_ping directly. No user UI was opened.`,
        });
        if (typeof ctx.executeTool !== "function" || !ctx.tools.some(tool => tool.name === "agent_ping")) {
          return unavailable("agent_ping is not callable");
        }
        const message = [
          `Question: ${question}`,
          context ? `Context: ${context}` : "",
          options?.length ? `Options:\n${options.map((option, i) => `${i + 1}. ${option}`).join("\n")}` : "",
          "Answer from known context or ask the user, then resume this child with agent_resume. Cancellation is unanswered, not consent.",
        ].filter(Boolean).join("\n\n");
        try {
          const outcome = await ctx.executeTool("agent_ping", { message }, { signal });
          if (outcome.isError || outcome.result.isError) {
            return unavailable("agent_ping failed or was denied");
          }
          // Success means handed to Herdr, not answered. Herdr owns sidecars and shutdown.
          return result({
            status: "forwarded", question,
            message: "Forwarded to the Herdr parent; unanswered here. Wait for the parent to resume this child with agent_resume.",
          });
        } catch (error) {
          if (signal?.aborted) return cancelled();
          return unavailable(`agent_ping could not complete (${error instanceof Error ? error.message : String(error)})`);
        }
      }

      if (!ctx.hasUI) {
        return result({
          status: "unavailable", question,
          message: "Unanswered: user UI is unavailable. Run in interactive Pi or an RPC client supporting input/select dialogs.",
        });
      }
      const title = context ? `${question}\n\n${context}` : question;

      // The custom popup is the TUI path: it can scroll, mark a recommendation and
      // always offer free text. RPC/print keep the native dialogs below.
      if (ctx.mode === "tui" && typeof ctx.ui.custom === "function") {
        let component: AskUserPopup | undefined;
        const onAbort = () => component?.cancel();
        if (signal?.aborted) return cancelled();
        signal?.addEventListener("abort", onAbort, { once: true });
        try {
          const answer = await ctx.ui.custom<AskAnswer | string | undefined>((tui, theme, _keys, done) => {
            component = new AskUserPopup({
              question, context, options, recommended,
              theme,
              terminalRows: () => overlayRows(tui.terminal.rows, 90),
              onDone: done,
            });
            return component;
          }, { overlay: true, overlayOptions: popupOverlayOptions("84%", 46, "90%") as any });
          if (signal?.aborted || answer === undefined) return cancelled();
          const answerValue = typeof answer === "string" ? answer : answer.value;
          if (!answerValue || !answerValue.trim()) return cancelled();

          const kind = typeof answer === "string"
            ? (options?.includes(answer) ? "option" : "text")
            : answer.kind;

          if (kind === "option" && options?.length && !options.includes(answerValue)) {
            return result({
              status: "unavailable", question,
              message: "Unanswered: UI returned an invalid choice. Ask again; do not infer consent.",
            });
          }
          return result({
            status: "answered",
            question,
            answer: answerValue.trim(),
            answeredWith: kind,
            ...(kind === "option" ? { matchedOption: answerValue.trim() } : {}),
          });
        } catch (error) {
          if (signal?.aborted) return cancelled();
          return result({
            status: "unavailable", question,
            message: `Unanswered: user dialog failed (${error instanceof Error ? error.message : String(error)}). Retry using a supported UI.`,
          });
        } finally {
          signal?.removeEventListener("abort", onAbort);
        }
      }

      // Web surface: the in-process server binds a headless UI context in
      // "print" mode. Render the question as a plugin dialog whose option
      // actions resolve through the plugin action pipeline.
      if (ctx.mode !== "tui" && ctx.mode !== "rpc") {
        return await askInWeb(question, context, options, recommended, signal);
      }

      try {
        const labels = options?.map((option, index) =>
          recommended === index + 1 ? `${option}  (recommended answer)` : option) ?? [];
        const byLabel = new Map(labels.map((label, index) => [label, options![index]!]));
        const selected = options?.length
          ? await ctx.ui.select(title, labels, { signal })
          : await ctx.ui.input(title, undefined, { signal });
        const answer = options?.length && selected !== undefined
          ? (byLabel.get(selected) ?? selected)
          : selected;
        if (signal?.aborted || answer === undefined || !answer.trim()) return cancelled();
        if (options?.length && !options.includes(answer)) {
          return result({ status: "unavailable", question, message: "Unanswered: UI returned an invalid choice. Ask again; do not infer consent." });
        }
        return result({
          status: "answered",
          question,
          answer: answer.trim(),
          answeredWith: options?.length ? "option" : "text",
          ...(options?.length ? { matchedOption: answer.trim() } : {}),
        });
      } catch (error) {
        if (signal?.aborted) return cancelled();
        return result({ status: "unavailable", question, message: `Unanswered: user dialog failed (${error instanceof Error ? error.message : String(error)}). Retry using a supported UI.` });
      }
    },
  });
}
