/**
 * child-health.ts — the parent's mechanical read of a child's transcript.
 *
 * The pane probe answers "is there a process"; it cannot answer "is it stuck on
 * a provider error". A child in pi's own retry shows a changing countdown, so the
 * pane-tail stall rule never fires, and an interactive (non auto-exit) child never
 * self-reports. The session file is written by the child's own harness regardless
 * of what the model does, so it is the honest signal: if the LAST assistant
 * message is `stopReason: "error"` and nothing has been written since, the child
 * is stuck on that error.
 *
 * Pure over a path + clock so it can be tested without panes.
 */
import { readFileSync, statSync } from "node:fs";

import { classifyChildError, type ChildErrorVerdict } from "./child-error.ts";

export interface ChildHealth {
  /** Last transcript write, ms epoch; null when the file is unreadable. */
  lastActivityAt: number | null;
  /** `provider/model` of the last assistant turn, so a failure can be pinned to the model that had it. */
  model?: string;
  /** The trailing provider error, when the last assistant turn failed. */
  error?: { message: string; verdict: ChildErrorVerdict; at: number | null };
}

/** The last assistant message with its stopReason, scanning from the end. */
function lastAssistant(entries: any[]): any | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry?.type === "message" && entry.message?.role === "assistant") return entry;
    // A newer user/toolResult message means the run moved past that error.
    if (entry?.type === "message" && (entry.message?.role === "user" || entry.message?.role === "toolResult")) {
      return undefined;
    }
  }
  return undefined;
}

export function readChildHealth(sessionFile: string): ChildHealth {
  let lastActivityAt: number | null = null;
  try {
    lastActivityAt = statSync(sessionFile).mtimeMs;
  } catch {
    return { lastActivityAt: null };
  }
  const entries: any[] = [];
  try {
    // Only the tail matters; a transcript can be megabytes.
    const lines = readFileSync(sessionFile, "utf8").split("\n").filter((line) => line.trim()).slice(-40);
    for (const line of lines) {
      try {
        entries.push(JSON.parse(line));
      } catch {
        // a half-written trailing line is not a verdict
      }
    }
  } catch {
    return { lastActivityAt };
  }
  const last = lastAssistant(entries);
  const provider = last?.message?.provider;
  const modelId = last?.message?.model;
  const model = typeof provider === "string" && typeof modelId === "string" ? `${provider}/${modelId}` : undefined;
  if (last?.message?.stopReason === "error") {
    const message = String(last.message.errorMessage ?? "Model error (stopReason: error).");
    const at = Date.parse(last.timestamp ?? "");
    return {
      lastActivityAt,
      ...(model ? { model } : {}),
      error: { message, verdict: classifyChildError(message), at: Number.isFinite(at) ? at : lastActivityAt },
    };
  }
  return { lastActivityAt, ...(model ? { model } : {}) };
}

/**
 * Is a trailing error terminal rather than mid-retry?
 *
 * pi retries a failed request itself with its own backoff and writes each failed
 * attempt. The error is terminal only when it has outlived the longest wait the
 * provider asked for (or the grace floor) with no later write.
 */
export function errorIsTerminal(
  health: ChildHealth,
  nowMs: number,
  options: { graceMs: number },
): boolean {
  if (!health.error) return false;
  const since = Math.max(health.error.at ?? 0, health.lastActivityAt ?? 0);
  const wait = Math.max(options.graceMs, (health.error.verdict.retryAfterMs ?? 0) + 15_000);
  // Aborted runs were stopped on purpose; the watchdog trip owns that case.
  if (health.error.verdict.class === "aborted") return false;
  return nowMs - since >= wait;
}
