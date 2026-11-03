/**
 * child-output.ts — did a child ever produce output, judged from its session log?
 *
 * A launch that never reached a model turn (no response headers, bad credentials,
 * pane killed before the first message) must not spend the parent's batch budget.
 * The session JSONL is the only durable record of that, so the check reads it.
 *
 * Pure: takes the file's text, so the rule is testable without a filesystem.
 */

/**
 * True when at least one assistant message carries visible text or a tool call.
 * Empty or aborted assistant turns (`content: []`, stopReason `aborted`) do not count.
 */
export function sessionHasAssistantOutput(jsonl: string): boolean {
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = (entry as { type?: unknown; message?: { role?: unknown; content?: unknown } } | null)?.message;
    if ((entry as { type?: unknown } | null)?.type !== "message") continue;
    if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
    const produced = message.content.some((part: unknown) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (p?.type === "toolCall") return true;
      return p?.type === "text" && String(p.text ?? "").trim() !== "";
    });
    if (produced) return true;
  }
  return false;
}
