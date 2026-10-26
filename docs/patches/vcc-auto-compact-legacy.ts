import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import { convertToLlm, estimateTokens } from "@earendil-works/pi-coding-agent";
// Reuse the installed pi-vcc engine; no LLM/default compactor is involved.
import { compile } from "../npm/node_modules/pi-vcc/src/core/summarize.ts";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

interface AutoCompactConfig {
  enabled?: boolean;
  maxPercent?: number;
}

export function loadConfig(): AutoCompactConfig {
  try {
    const config = JSON.parse(fs.readFileSync(process.env.PI_VCC_CONFIG_PATH ?? path.join(os.homedir(), ".pi", "agent", "pi-vcc-config.json"), "utf8"));
    return config.autoCompact && typeof config.autoCompact === "object" ? config.autoCompact : {};
  } catch {
    return {};
  }
}

function tokens(entries: ProjectedSessionEntry[]): number {
  return entries.reduce((total, entry) => total + entry.messages.reduce((n, message) => n + estimateTokens(message), 0), 0);
}

/** Refuse a cut that would orphan a tool result or discard a completed call's result. */
export function hasCompleteToolPairs(entries: ProjectedSessionEntry[]): boolean {
  const pending = new Set<string>();
  for (const { messages } of entries) {
    for (const message of messages) {
      if (message.role === "assistant") {
        if (pending.size) return false;
        for (const block of message.content) {
          if (block.type === "toolCall") {
            if (pending.has(block.id)) return false;
            pending.add(block.id);
          }
        }
      } else if (message.role === "toolResult") {
        if (!pending.delete(message.toolCallId)) return false;
      } else if (message.role !== "system" && pending.size) {
        return false;
      }
    }
  }
  return pending.size === 0;
}

/** Only use finalized, projected entries: raw history may contain omitted/replaced text. */
export function planCompaction(event: TurnEndEvent, threshold: number) {
  const entries = event.context.contextEntries;
  const newest = entries.findIndex((entry) => entry.sourceEntry.id === event.messageEntryId);
  if (newest < 0 || entries[newest].sourceEntry.type !== "message" ||
      !entries[newest].messages.some((message) => message.role === "assistant")) return;

  // Retain a recent tail, always including the newest assistant and its complete tool batch.
  // Scale retention and minimum-progress budgets down for small windows, NOT the trigger.
  const keepBudget = Math.min(20_000, Math.floor(threshold / 4));
  const minimumNewTokens = Math.max(128, Math.min(4096, Math.floor(threshold / 12)));
  let cut = newest;
  for (let i = newest - 1; i >= 0 && tokens(entries.slice(cut)) < keepBudget; i--) {
    const entry = entries[i];
    if (entry.sourceEntry.type === "message" &&
        entry.messages.some((message) => message.role === "user" || message.role === "assistant")) {
      // An oversized older message belongs in the summary, not in an oversized retained tail.
      if (tokens(entries.slice(i)) > keepBudget) break;
      cut = i;
    }
  }
  if (cut <= 0) return;
  const tail = entries.slice(cut);
  const prefix = entries.slice(0, cut);
  if (!hasCompleteToolPairs(tail) || !hasCompleteToolPairs(prefix)) return;
  if (event.toolResultEntryIds.some((id) => !tail.some((entry) => entry.sourceEntry.id === id))) return;

  const messages = prefix.flatMap((entry) => entry.messages).filter((message) => message.role !== "system");
  const prefixTokens = messages.reduce((n, message) => n + estimateTokens(message), 0);
  const newTokens = messages.filter((message) => message.role !== "compactionSummary")
    .reduce((n, message) => n + estimateTokens(message), 0);
  // Avoid repeatedly summarizing an existing summary when fixed system/tool overhead is high.
  if (prefixTokens < minimumNewTokens * 2 || newTokens < minimumNewTokens) return;
  return { messages, prefixTokens, firstKeptEntryId: entries[cut].sourceEntry.id };
}

/** Dependency injection lets tests verify boundaries separately from the real pi-vcc engine. */
export function registerAutoCompact(
  pi: ExtensionAPI,
  readConfig: () => AutoCompactConfig = loadConfig,
  compileSummary: typeof compile = compile,
) {
  let busy = false;
  let sessionId: string | undefined;
  let failuresToSkip = 0;

  pi.on("turn_end", async (event, ctx: ExtensionContext) => {
    const currentSession = ctx.sessionManager.getSessionId();
    if (sessionId !== currentSession) {
      sessionId = currentSession;
      failuresToSkip = 0;
    }
    if (busy || event.outcome !== "completed" || ctx.signal?.aborted) return;
    if (failuresToSkip > 0) {
      failuresToSkip--;
      return;
    }
    const config = readConfig();
    const percent = config.maxPercent ?? 20;
    if (config.enabled === false || !Number.isFinite(percent) || percent <= 0 || percent >= 100) return;
    // getContextUsage is authoritative for committed context, not earlier handlers' proposed edits.
    // Plain custom metadata is harmless; never mix staged context changes or preview-only IDs.
    if (event.entries.some((entry) => entry.type !== "custom")) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) ||
        !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 || !ctx.model) return;
    const threshold = usage.contextWindow * percent / 100;
    if (usage.tokens < threshold) return;
    const plan = planCompaction(event, threshold);
    if (!plan) return;

    const leafId = ctx.sessionManager.getLeafId();
    busy = true;
    try {
      if (ctx.hasUI) ctx.ui.setStatus("auto-compact", `pi-vcc compacting (${percent}% trigger)…`);
      const previousSummary = plan.messages.filter((message) => message.role === "compactionSummary")
        .map((message) => message.summary).join("\n\n") || undefined;
      const messages = convertToLlm(plan.messages.filter((message) => message.role !== "compactionSummary"));
      const summary = (await compileSummary({
        messages: messages as Parameters<typeof compile>[0]["messages"],
        previousSummary,
      })).trim();

      if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== currentSession ||
          ctx.sessionManager.getLeafId() !== leafId) return;
      if (!summary) throw new Error("pi-vcc summary was empty");
      const summaryTokens = Math.ceil(summary.length / 4);
      if (summaryTokens >= plan.prefixTokens - Math.min(1024, threshold / 100)) {
        throw new Error("Summary would not reduce context enough");
      }

      // This supported boundary draft is committed before the next request. Do NOT call
      // ctx.compact() (it aborts active runs), or force continue (it can create extra turns).
      return {
        entries: [...event.entries, {
          type: "compaction" as const,
          summary,
          firstKeptEntryId: plan.firstKeptEntryId,
          details: {
            compactor: "pi-vcc", version: 1, thresholdPercent: percent,
            trigger: "turn_end", sourceMessageCount: messages.length,
            previousSummaryUsed: Boolean(previousSummary),
            sections: [...summary.matchAll(/^\[(.+?)\]/gm)].map((match) => match[1]),
          },
        }],
      };
    } catch (error) {
      failuresToSkip = 3;
      if (!ctx.signal?.aborted && ctx.hasUI) {
        ctx.ui.notify(`Auto-compaction skipped; history preserved: ${error instanceof Error ? error.message : String(error)}`, "warning");
      }
    } finally {
      busy = false;
      if (ctx.hasUI) ctx.ui.setStatus("auto-compact", undefined);
    }
  });
}

export default function (pi: ExtensionAPI) {
  registerAutoCompact(pi);
}
