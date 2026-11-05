import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  RECOVERY_ENTRY, MAX_DRAFT_BYTES, MAX_PENDING_DRAFTS, MAX_AUTO_RECOVERIES,
  checkSize, completeLines, digest, draftPath, fileBaseline, interruptedArguments, isStreamDisconnect, recoveryContext,
  type StreamDraft,
} from "../lib/stream-recovery.ts";

export default function streamRecoveryExtension(pi: ExtensionAPI) {
  const drafts = new Map<string, StreamDraft>();
  const streamedArguments = new Map<string, { json: string; bytes: number } | null>();
  const lengthCalls = new Map<string, string>();
  let enabled = true;
  let attempts = 0;
  let disconnect = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;

  function cancelTimer() {
    generation++;
    if (timer) clearTimeout(timer);
    timer = undefined;
  }
  function save(draft: StreamDraft) {
    pi.appendEntry(RECOVERY_ENTRY, { draft });
    drafts.set(draft.id, draft);
  }
  function pending() {
    return [...drafts.values()].filter(draft => draft.status === "pending");
  }
  function restore(ctx: ExtensionContext) {
    cancelTimer();
    drafts.clear();
    streamedArguments.clear();
    lengthCalls.clear();
    enabled = true;
    attempts = 0;
    disconnect = false;
    for (const entry of ctx.sessionManager.getBranch()) {
      if (entry.type !== "custom" || entry.customType !== RECOVERY_ENTRY) continue;
      const data = entry.data as { draft?: StreamDraft; enabled?: boolean } | undefined;
      if (typeof data?.enabled === "boolean") enabled = data.enabled;
      if (data?.draft?.id) drafts.set(data.draft.id, data.draft);
    }
  }

  async function capture(message: { role: string; stopReason?: string; timestamp?: number; content: unknown }, ctx: ExtensionContext) {
    if (message.role !== "assistant" || !["error", "length"].includes(message.stopReason ?? "") || !Array.isArray(message.content)) return;
    let captured = false;
    for (const call of message.content) {
      if (call.type !== "toolCall" || !["write", "bash", "recover_stream"].includes(call.name)) continue;
      const args = interruptedArguments(call, streamedArguments.get(call.id)?.json);
      if (!args) continue;
      try {
        if (call.name === "recover_stream") {
          const draft = typeof args.id === "string" ? drafts.get(args.id) : undefined;
          if (!draft || draft.status !== "pending" || args.version !== draft.version || typeof args.suffix !== "string") continue;
          captured = true;
          if (message.stopReason === "length") lengthCalls.set(call.id, draft.id);
          const suffix = completeLines(args.suffix);
          if (!suffix) continue;
          const prefix = draft.prefix + suffix;
          checkSize(prefix);
          save({ ...draft, version: draft.version + 1, prefix });
        } else if (call.name === "write" || call.name === "bash") {
          const text = args[call.name === "write" ? "content" : "command"];
          if (typeof text !== "string" || (call.name === "write" && typeof args.path !== "string")) continue;
          const prefix = completeLines(text);
          if (!prefix) continue;
          if (pending().length >= MAX_PENDING_DRAFTS) throw new Error("At most 8 pending recovery drafts are retained; discard obsolete drafts first.");
          checkSize(prefix);
          const id = `draft-${digest(`${message.timestamp}:${call.id}`).slice(0, 12)}`;
          if (drafts.has(id)) {
            if (drafts.get(id)?.status === "pending") {
              captured = true;
              if (message.stopReason === "length") lengthCalls.set(call.id, id);
            }
            continue;
          }
          const path = call.name === "write" ? args.path as string : undefined;
          save({
            id, version: 1, tool: call.name, cwd: ctx.cwd, path, prefix, status: "pending",
            ...(path !== undefined ? { baseline: await fileBaseline(ctx.cwd, path) } : {}),
            ...(typeof args.timeout === "number" ? { timeout: args.timeout } : {}),
          });
          captured = true;
          if (message.stopReason === "length") lengthCalls.set(call.id, id);
        }
      } catch (error) {
        if (ctx.hasUI) ctx.ui.notify(`Could not checkpoint interrupted ${call.name}: ${String(error)}`, "warning");
      }
    }
    return captured;
  }

  pi.on("session_start", (_event, ctx) => restore(ctx));
  pi.on("session_tree", (_event, ctx) => restore(ctx));
  pi.on("session_shutdown", () => {
    cancelTimer();
    streamedArguments.clear();
    lengthCalls.clear();
  });
  pi.on("message_start", event => {
    if (event.message.role === "assistant") {
      streamedArguments.clear();
      lengthCalls.clear();
    }
  });
  pi.on("message_update", event => {
    const update = event.assistantMessageEvent;
    if (update.type !== "toolcall_delta" || event.message.role !== "assistant") return;
    const call = event.message.content[update.contentIndex];
    if (call?.type !== "toolCall" || !["write", "bash", "recover_stream"].includes(call.name)) return;
    if (!streamedArguments.has(call.id) && streamedArguments.size >= MAX_PENDING_DRAFTS) return;
    const previous = streamedArguments.get(call.id);
    // Keep raw deltas: providers can mutate partial.arguments to {} before hooks drain.
    // Bound memory independently of parsed drafts; overflowing calls are not salvaged.
    if (previous === null) return;
    const bytes = (previous?.bytes ?? 0) + Buffer.byteLength(update.delta, "utf8");
    streamedArguments.set(call.id, bytes > 8 * MAX_DRAFT_BYTES ? null : { json: (previous?.json ?? "") + update.delta, bytes });
  });
  pi.on("input", event => {
    if (event.source !== "extension") {
      cancelTimer();
      attempts = 0;
      disconnect = false;
    }
  });
  pi.on("message_end", async (event, ctx) => {
    if (event.message.role === "toolResult") {
      const id = lengthCalls.get(event.message.toolCallId);
      lengthCalls.delete(event.message.toolCallId);
      const draft = id ? drafts.get(id) : undefined;
      // Pi's length-limit failures bypass tool_result. Keep the failure, but replace
      // its generic "re-issue complete arguments" advice with the saved-draft route.
      if (event.message.isError && draft?.status === "pending") return {
        message: {
          ...event.message,
          content: [{ type: "text", text: `Tool call "${event.message.toolName}" was not executed: the response hit the output token limit. Saved prefix: ${draft.id}, version ${draft.version}, ${draft.prefix.length} characters. Do NOT re-issue the full original arguments. Continue with recover_stream using this id/version and only the missing suffix. Stage small newline-terminated chunks with finish=false; use finish=true only when the entire file/command is complete. The partial final line was discarded; no target was changed and no command ran.` }],
        },
      };
      return;
    }
    if (event.message.role !== "assistant") return;
    try {
      const captured = await capture(event.message, ctx);
      disconnect = event.message.stopReason === "error" && isStreamDisconnect(event.message.errorMessage) && captured === true;
    } finally {
      streamedArguments.clear();
    }
  });
  pi.on("tool_result", (event, ctx) => {
    // A model can elect to regenerate instead. Retire drafts whose target was actually written.
    if (event.isError || event.toolName !== "write" || typeof event.input.path !== "string") return;
    for (const draft of pending()) {
      if (draft.cwd === ctx.cwd && draft.tool === "write" && draftPath(draft.cwd, draft.path!) === draftPath(ctx.cwd, event.input.path)) {
        save({ ...draft, status: "finished" });
      }
    }
  });
  pi.on("context", event => {
    const content = recoveryContext(pending());
    if (!content) return;
    return { messages: [...event.messages, { role: "custom" as const, customType: RECOVERY_ENTRY, content, display: false, timestamp: Date.now() }] };
  });
  pi.on("agent_settled", (event, ctx) => {
    cancelTimer();
    if (!disconnect) attempts = 0;
    // Native retries have already finished. Esc, queued user input, and headless runs win.
    if (event.aborted || !enabled || !disconnect || !pending().length || !ctx.hasUI || ctx.hasPendingMessages() || attempts >= MAX_AUTO_RECOVERIES) return;
    const token = generation;
    const delay = 2000 * 2 ** attempts;
    attempts++;
    timer = setTimeout(() => {
      timer = undefined;
      if (generation !== token || !ctx.isIdle() || ctx.hasPendingMessages() || !enabled || !pending().length) return;
      disconnect = false;
      pi.sendMessage({
        customType: RECOVERY_ENTRY,
        content: "The endpoint disconnected during tool-call generation. Continue the current task using the saved stream-recovery drafts; generate only missing suffixes, not the saved prefixes. Do not replay executed tools.",
        display: true,
      }, { triggerTurn: true });
    }, delay);
    if (ctx.hasUI) ctx.ui.notify(`Saved interrupted tool draft. Continuing in ${delay / 1000}s (${attempts}/${MAX_AUTO_RECOVERIES}); /stream-recovery off stops automatic recovery.`, "info");
  });

  pi.registerTool({
    name: "recover_stream",
    label: "Recover interrupted tool draft",
    description: "Inspect or continue an interrupted write/bash draft without regenerating its prefix. With only id, inspect the saved text (last 6000 characters). To append NEW text provide current version, suffix, and finish. finish=false only checkpoints; finish=true invokes the original tool through normal hooks. Consumed drafts never replay, even after errors. Prefixes end at a complete newline; regenerate the discarded partial final line. Max draft 1 MiB. Do not execute incomplete commands.",
    promptSnippet: "Continue interrupted file/command generation using saved prefixes",
    parameters: Type.Object({
      id: Type.String(),
      version: Type.Optional(Type.Integer({ minimum: 1 })),
      finish: Type.Optional(Type.Boolean()),
      suffix: Type.Optional(Type.String()),
    }),
    reachesTools: () => ["write", "bash"],
    async execute(_id, args, signal, onUpdate, ctx) {
      const draft = drafts.get(args.id);
      if (!draft || draft.status !== "pending") throw new Error("Draft unavailable or already consumed. Inspect the original result/effects before issuing a fresh tool call.");
      if (draft.cwd !== ctx.cwd) throw new Error("Draft belongs to a different working directory.");
      if (args.suffix === undefined) {
        return {
          content: [{ type: "text", text: JSON.stringify({ ...draft, prefix: draft.prefix.slice(-6000), totalCharacters: draft.prefix.length }) }],
          details: { id: draft.id, version: draft.version },
        };
      }
      if (args.version !== draft.version || args.finish === undefined) throw new Error(`Specify finish and the current version ${draft.version}; inspect the draft before continuing.`);
      if (signal?.aborted) throw new Error("Recovery cancelled");
      const prefix = draft.prefix + args.suffix;
      checkSize(prefix);
      if (!args.finish) {
        // Staged chunks also end at newlines, so another disconnect has an unambiguous boundary.
        if (!prefix.endsWith("\n")) throw new Error("Non-final chunks must end with a newline.");
        save({ ...draft, prefix, version: draft.version + 1 });
        return { content: [{ type: "text", text: `Saved ${prefix.length} characters. Continue ${draft.id} at version ${draft.version + 1}; nothing executed.` }], details: { id: draft.id, version: draft.version + 1 } };
      }
      if (draft.tool === "write" && await fileBaseline(ctx.cwd, draft.path!) !== draft.baseline) {
        throw new Error("Target file changed since interruption. Inspect it and use a fresh edit/write; the draft has not been executed.");
      }
      if (signal?.aborted) throw new Error("Recovery cancelled");
      // The metadata await above permits sibling calls to stage/consume this ID.
      if (drafts.get(draft.id) !== draft) throw new Error("Draft changed during finalization; inspect its current state before retrying.");
      // Persist the at-most-once boundary BEFORE invoking anything with side effects.
      // Even a process death or a blocked/failed nested call leaves it non-replayable.
      save({ ...draft, prefix, version: draft.version + 1, status: "executing" });
      try {
        const input = draft.tool === "write"
          ? { path: draftPath(ctx.cwd, draft.path!), content: prefix }
          : { command: prefix, ...(draft.timeout !== undefined ? { timeout: draft.timeout } : {}) };
        const outcome = await ctx.executeTool(draft.tool, input, { signal, onUpdate });
        return { ...outcome.result, isError: outcome.isError, details: { recovery: { id: draft.id }, original: outcome.result.details } };
      } finally {
        save({ ...draft, prefix, version: draft.version + 1, status: "finished" });
      }
    },
  });

  pi.registerCommand("stream-recovery", {
    description: "Interrupted drafts: status | on | off | resume | import | discard <id>",
    handler: async (args, ctx) => {
      const [action = "status", id] = args.trim().split(/\s+/).filter(Boolean);
      let text: string;
      if (action === "on" || action === "off") {
        cancelTimer();
        enabled = action === "on";
        if (enabled) attempts = 0;
        pi.appendEntry(RECOVERY_ENTRY, { enabled });
        text = `Automatic stream recovery ${enabled ? "on" : "off"}. Saved drafts are retained.`;
      } else if (action === "discard") {
        cancelTimer();
        const draft = drafts.get(id);
        if (!draft || draft.status !== "pending") text = "No pending draft with that id.";
        else { save({ ...draft, status: "discarded" }); text = `Discarded ${id}; nothing executed.`; }
      } else if (action === "import") {
        if (!ctx.isIdle()) { ctx.ui.notify("Wait until Pi is idle before importing an old interruption.", "warning"); return; }
        // Explicit opt-in for pre-extension sessions. Do not resurrect failures preceding completed work.
        const last = [...ctx.sessionManager.getBranch()].reverse().find(entry => entry.type === "message" && entry.message.role === "assistant" && entry.message.stopReason !== "aborted");
        if (last?.type === "message" && last.message.role === "assistant") await capture(last.message, ctx);
        text = `${pending().length} pending draft(s). Use /stream-recovery resume to continue.`;
      } else if (action === "resume") {
        cancelTimer();
        if (!pending().length) text = "No pending drafts.";
        else {
          attempts = 0;
          pi.sendUserMessage("Continue the current task using saved stream-recovery drafts. Generate only missing suffixes; do not replay executed tools.", { deliverAs: "followUp" });
          return;
        }
      } else {
        text = `Automatic recovery: ${enabled ? "on" : "off"}; at most ${MAX_AUTO_RECOVERIES} extra continuations after native retries (interactive/RPC only).\n`
          + (pending().map(draft => `${draft.id} v${draft.version} ${draft.tool} ${draft.path ?? "(command)"}: ${draft.prefix.length} characters saved`).join("\n") || "No pending drafts.");
      }
      if (ctx.hasUI) ctx.ui.notify(text, "info");
      else pi.sendMessage({ customType: RECOVERY_ENTRY, content: text, display: true }, { triggerTurn: false });
    },
  });
}
