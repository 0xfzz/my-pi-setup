// Fixture session owned by the e2e plugin. Core starts it through the
// composition-root hook; it contains no plugin view registration.
import { WEB_TEST_FIXTURES } from "../../../config/registry.config.ts";
import { FIXTURE_SESSION_ID } from "./fixtures.ts";
import { registerSession } from "../../../core/server/sessions.ts";

/**
 * The fixture session for e2e runs (PI_WEB_TEST_PLUGIN_VIEWS=1): a live
 * session core with no real agent behind it. Its plugin views come from the
 * seeded store, its action requests flow through the seeded fixture bus, and
 * a prompt simulates a full agent turn — an assistant message with text and
 * a tool call, the tool execution and result, then a second assistant reply
 * streamed as markdown — emitted with small delays so realtime streaming,
 * collapsible tool calls and markdown rendering are observable in a browser.
 * The turn then names the session, exactly as the auto-title extension does at
 * the end of a real turn, so the sidebar's rename path is observable too.
 */
export function registerFixtureSession(): void {
  const sessionId = FIXTURE_SESSION_ID;
  let sessionName: string | undefined;
  // Many listeners, like AgentSession.subscribe: the directory tap, the plugin
  // bridge and every browser stream subscribe to the same session. A
  // single-listener slot made the newest subscriber silently evict the others,
  // so the directory tap (running flags, renames) died as soon as a browser
  // opened the session — a fidelity gap no e2e could see past.
  const listeners = new Set<(event: unknown) => void>();
  const emit = (event: unknown): void => {
    for (const listener of listeners) listener(event);
  };
  const delay = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      setTimeout(resolve, ms);
    });

  const firstText = "Checking the plans directory first…";
  const finalMarkdown = [
    "## Result",
    "",
    "The plan is **ready**:",
    "",
    "- port the slot adapters",
    "- verify the e2e suite",
    "",
    "1. start the server",
    "2. run the suite",
    "",
    "```sh",
    "ls plans/",
    "```",
    "",
    "| step | state |",
    "| --- | --- |",
    "| slots | done |",
    "| e2e | pending |",
    "",
    "```mermaid",
    "flowchart TD",
    "  A[Start] --> B{Done?}",
    "  B -->|yes| C[Ship]",
    "  B -->|no| A",
    "```",
    "",
    "> verified locally",
    "",
    "All checks passed.",
  ].join("\n");

  const chunks = (text: string, size: number): string[] => {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += size) {
      parts.push(text.slice(i, i + size));
    }
    return parts;
  };

  /** The compaction the fixture is running, if any (reported as isCompacting). */
  let compacting: "manual" | "threshold" | null = null;

  /**
   * Simulate a compaction the way pi's own compact paths announce one: a start
   * event, the summarizing pause, then an end event. `instructions` picks the
   * outcome the e2e needs — "fail" ends with pi's failure text for an
   * automatic compaction (which has no HTTP response to carry the error, so
   * the browser's marker row is the only carrier), "abort" ends cancelled, and
   * anything else succeeds. No entry is written: the fixture has no session
   * file, and the transcript marker is covered against a seeded file.
   */
  const simulateCompaction = async (instructions: string): Promise<void> => {
    const reason = instructions === "fail" ? "threshold" : "manual";
    compacting = reason;
    emit({ type: "compaction_start", reason });
    await delay(600);
    compacting = null;
    if (instructions === "abort") {
      emit({ type: "compaction_end", reason, aborted: true, willRetry: false });
      return;
    }
    if (instructions === "fail") {
      emit({
        type: "compaction_end",
        reason,
        aborted: false,
        willRetry: false,
        errorMessage: "Auto-compaction failed: fixture says the summary would not reduce context",
      });
      return;
    }
    emit({
      type: "compaction_end",
      reason,
      aborted: false,
      willRetry: false,
      result: { tokensBefore: 128432, estimatedTokensAfter: 12000 },
    });
  };

  const simulateTurn = async (): Promise<void> => {
    emit({ type: "agent_start" });
    // Assistant message 1: text + a tool call.
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (const chunk of chunks(firstText, 12)) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
      await delay(45);
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: firstText } });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_start", contentIndex: 1, id: "call-1", toolName: "bash" } });
    emit({ type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex: 1, delta: '{"cmd":"ls plans/"}' } });
    emit({
      type: "message_update",
      assistantMessageEvent: {
        type: "toolcall_end",
        contentIndex: 1,
        toolCall: { id: "call-1", name: "bash", arguments: { cmd: "ls plans/" } },
      },
    });
    emit({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: firstText },
          { type: "toolCall", toolCallId: "call-1", toolName: "bash", rawInput: '{"cmd":"ls plans/"}' },
        ],
      },
    });
    // The tool executes and returns its result.
    emit({ type: "tool_execution_start", toolCallId: "call-1", toolName: "bash" });
    await delay(150);
    emit({ type: "tool_execution_update", toolCallId: "call-1", toolName: "bash", partialResult: { stdout: "plans.md" } });
    await delay(150);
    emit({ type: "tool_execution_end", toolCallId: "call-1", toolName: "bash", isError: false });
    emit({
      type: "message_end",
      message: {
        role: "toolResult",
        toolCallId: "call-1",
        toolName: "bash",
        isError: false,
        content: [{ type: "text", text: "plans.md" }],
      },
    });
    // Assistant message 2: the markdown reply, streamed.
    emit({ type: "message_start", message: { role: "assistant", content: [] } });
    emit({ type: "message_update", assistantMessageEvent: { type: "text_start", contentIndex: 0 } });
    for (const chunk of chunks(finalMarkdown, 24)) {
      emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk } });
      await delay(35);
    }
    emit({ type: "message_update", assistantMessageEvent: { type: "text_end", contentIndex: 0, content: finalMarkdown } });
    emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: finalMarkdown }] } });
    // A real turn ends by naming the session (auto-title, or a /name). The
    // name is announced the way pi announces it, so the sidebar's rename path
    // — directory stream in, row label out — is exercised, not just the view.
    sessionName = WEB_TEST_FIXTURES.sessionTitle;
    emit({ type: "session_info_changed", name: sessionName });
    emit({ type: "agent_settled" });
  };

  registerSession(
    {
      sessionId,
      subscribe: (next: (event: unknown) => void) => {
        listeners.add(next);
        // The stream's connect announcement goes to the newcomer only.
        next({ type: "agent_start" });
        return () => {
          listeners.delete(next);
        };
      },
      prompt: async () => {
        void simulateTurn();
      },
      // The core's own compaction path (web/core/server/sessions.ts): the
      // browser's /compact reaches the fixture exactly as it reaches a real
      // in-process session.
      compact: async (instructions?: string) => {
        await simulateCompaction(instructions ?? "");
      },
      abort: async () => {},
      isStreaming: () => false,
      getSessionName: () => sessionName,
      getState: () => ({
        sessionId,
        sessionFile: "",
        isStreaming: false,
        isBashRunning: false,
        isCompacting: compacting !== null,
        model: undefined,
        contextUsage: null,
        thinkingLevel: "off",
      }),
    },
    // Files share the real session root (process.cwd()); the viewer e2e
    // overrides it to a fixture directory so it can browse known files.
    process.env[WEB_TEST_FIXTURES.filesRootEnv] ?? process.cwd(),
    "",
  );
}