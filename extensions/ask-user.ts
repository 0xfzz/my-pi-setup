import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { isSubagentChildSession } from "../lib/subagent-context.ts";

type AskResult = {
  status: "answered" | "cancelled" | "forwarded" | "unavailable";
  question: string;
  answer?: string;
  message?: string;
};

const parentGuidance =
  "A Herdr child is waiting on you. Answer from reliable known context if possible. " +
  "Otherwise ask the user with ask_user. Resume that child with subagent_resume using the supplied session path and the answer. " +
  "Cancellation is unanswered, never consent: report that explicitly when resuming; do not invent an answer.";
const childGuidance =
  "In a Herdr child (PI_SUBAGENT_SESSION), never open user UI. Prefer calling orch_ping directly with your question, context, and options. " +
  "orch_ping notifies the parent and shuts down this child until the parent uses subagent_resume; " +
  "direct invocation avoids nested-tool shutdown interrupting ask_user's result. ask_user forwards through the same protocol, not a synchronous answer. " +
  "If forwarding is unavailable or denied, report the blocker; never fall back to user UI.";

function result(details: AskResult) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(details) }],
    details,
    ...(details.status === "unavailable" ? { isError: true } : {}),
  };
}

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

  pi.registerTool({
    name: "ask_user",
    label: "Ask User",
    description:
      "Ask one question and wait for a user answer, optionally offering exact choices. " +
      "A cancelled dialog is unanswered, never approval. In Herdr children this forwards to the parent and exits, not a synchronous user answer.",
    exposure: "model-only",
    executionMode: "sequential",
    reachesTools: () => ["orch_ping"],
    parameters: Type.Object({
      question: Type.String({ minLength: 1, description: "The single question to ask." }),
      context: Type.Optional(Type.String({ description: "Brief context needed to answer." })),
      options: Type.Optional(Type.Array(Type.String({ minLength: 1 }), {
        minItems: 1,
        uniqueItems: true,
        description: "Exact choices; omit for a free-text answer.",
      })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const { question, context, options } = params;
      const cancelled = () => result({
        status: "cancelled", question,
        message: "Unanswered. No consent or approval was given.",
      });
      if (signal?.aborted) return cancelled();
      if (!question.trim()) {
        return result({ status: "unavailable", question, message: "Provide a non-empty question." });
      }

      if (isSubagentChildSession(ctx)) {
        const unavailable = (reason: string) => result({
          status: "unavailable", question,
          message: `Unanswered: ${reason}. Ensure the Herdr orch_ping tool is loaded and permitted in this child, then call orch_ping directly. No user UI was opened.`,
        });
        if (typeof ctx.executeTool !== "function" || !ctx.tools.some(tool => tool.name === "orch_ping")) {
          return unavailable("orch_ping is not callable");
        }
        const message = [
          `Question: ${question}`,
          context ? `Context: ${context}` : "",
          options?.length ? `Options:\n${options.map((option, i) => `${i + 1}. ${option}`).join("\n")}` : "",
          "Answer from known context or ask the user, then resume this child with subagent_resume. Cancellation is unanswered, not consent.",
        ].filter(Boolean).join("\n\n");
        try {
          const outcome = await ctx.executeTool("orch_ping", { message }, { signal });
          if (outcome.isError || outcome.result.isError) {
            return unavailable("orch_ping failed or was denied");
          }
          // Success means handed to Herdr, not answered. Herdr owns sidecars and shutdown.
          return result({
            status: "forwarded", question,
            message: "Forwarded to the Herdr parent; unanswered here. Wait for the parent to resume this child with subagent_resume.",
          });
        } catch (error) {
          if (signal?.aborted) return cancelled();
          return unavailable(`orch_ping could not complete (${error instanceof Error ? error.message : String(error)})`);
        }
      }

      if (!ctx.hasUI) {
        return result({
          status: "unavailable", question,
          message: "Unanswered: user UI is unavailable. Run in interactive Pi or an RPC client supporting input/select dialogs.",
        });
      }
      const title = context ? `${question}\n\n${context}` : question;
      try {
        const answer = options?.length
          ? await ctx.ui.select(title, options, { signal })
          : await ctx.ui.input(title, undefined, { signal });
        if (signal?.aborted || answer === undefined || !answer.trim()) return cancelled();
        if (options?.length && !options.includes(answer)) {
          return result({ status: "unavailable", question, message: "Unanswered: UI returned an invalid choice. Ask again; do not infer consent." });
        }
        return result({ status: "answered", question, answer });
      } catch (error) {
        if (signal?.aborted) return cancelled();
        return result({ status: "unavailable", question, message: `Unanswered: user dialog failed (${error instanceof Error ? error.message : String(error)}). Retry using a supported UI.` });
      }
    },
  });
}
