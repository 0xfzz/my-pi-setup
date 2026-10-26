/**
 * Compaction cut-point planning.
 *
 * Two planners live here:
 *
 *   planBudgetedCompaction  the model-aware controller (current default)
 *   planLegacyCompaction    the previous `threshold/4` tail policy, kept only
 *                           for explicit `mode: "legacy"` compatibility
 *
 * Both operate on the canonical projected entries (context edits already
 * applied) and both refuse cuts that would orphan a tool result or discard the
 * results of the turn that just finished.
 */

import type { ContextBudget } from "./budget.ts";
import { DEFAULT_CHARS_PER_TOKEN, estimateMessageTokens } from "./estimate.ts";

export interface ProjectedEntryLike {
  sourceEntry: { id: string; type: string };
  messages: readonly unknown[];
}

export type MessageEstimator = (message: unknown) => number;

const roleOf = (message: unknown): string | undefined => {
  if (typeof message !== "object" || message === null) return undefined;
  const role = (message as Record<string, unknown>).role;
  return typeof role === "string" ? role : undefined;
};

export function sumMessages(
  messages: readonly unknown[],
  estimate: MessageEstimator,
): number {
  let total = 0;
  for (const message of messages) total += estimate(message);
  return total;
}

export function sumEntries(
  entries: readonly ProjectedEntryLike[],
  estimate: MessageEstimator,
): number {
  let total = 0;
  for (const entry of entries) total += sumMessages(entry.messages, estimate);
  return total;
}

/**
 * Refuse a cut that would orphan a tool result or discard a completed call's
 * result. Parallel call batches must stay on one side of the boundary.
 */
export function hasCompleteToolPairs(entries: readonly ProjectedEntryLike[]): boolean {
  const pending = new Set<string>();
  for (const { messages } of entries) {
    for (const message of messages) {
      const role = roleOf(message);
      if (role === "assistant") {
        if (pending.size) return false;
        const content = (message as Record<string, unknown>).content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          if (typeof block !== "object" || block === null) continue;
          const item = block as Record<string, unknown>;
          if (item.type !== "toolCall") continue;
          const id = typeof item.id === "string" ? item.id : undefined;
          if (!id) continue;
          if (pending.has(id)) return false;
          pending.add(id);
        }
      } else if (role === "toolResult") {
        const id = (message as Record<string, unknown>).toolCallId;
        if (typeof id !== "string" || !pending.delete(id)) return false;
      } else if (role !== "system" && pending.size) {
        return false;
      }
    }
  }
  return pending.size === 0;
}

export interface FixedOverhead {
  tokens: number;
  systemEntries: number;
  pendingTokens: number;
}

/**
 * Tokens that compaction cannot remove: the system prompt/tool block and any
 * queued steering messages. Used to size the retained tail honestly instead of
 * assuming the whole window is available.
 */
export function estimateFixedOverhead(
  entries: readonly ProjectedEntryLike[],
  pendingMessages: readonly unknown[] = [],
  estimate: MessageEstimator = (message) => estimateMessageTokens(message),
): FixedOverhead {
  let tokens = 0;
  let systemEntries = 0;
  for (const entry of entries) {
    const systemMessages = entry.messages.filter((message) => roleOf(message) === "system");
    if (systemMessages.length === 0) continue;
    systemEntries++;
    tokens += sumMessages(systemMessages, estimate);
  }
  const pendingTokens = sumMessages(pendingMessages, estimate);
  return { tokens: tokens + pendingTokens, systemEntries, pendingTokens };
}

export interface BudgetedPlanInput {
  entries: readonly ProjectedEntryLike[];
  /** Entry id of the assistant message that ended the completed turn. */
  messageEntryId: string;
  /** Tool-result entry ids produced by that turn; all must remain in the tail. */
  toolResultEntryIds?: readonly string[];
  budget: ContextBudget;
  fixedOverheadTokens?: number;
  estimate?: MessageEstimator;
}

export interface BudgetedPlan {
  cut: number;
  firstKeptEntryId: string;
  prefixMessages: unknown[];
  prefixTokens: number;
  /** Prefix tokens excluding any already-compacted summary. */
  newTokens: number;
  tailTokens: number;
  tailBudget: number;
  fixedOverheadTokens: number;
  /**
   * Set when the protected content cannot fit the soft post-compaction target
   * and the plan had to use the full input allowance instead.
   */
  exception?: "capacity";
}

const defaultEstimate: MessageEstimator = (message) => estimateMessageTokens(message);

function findNewestAssistant(
  entries: readonly ProjectedEntryLike[],
  messageEntryId: string,
): number {
  const newest = entries.findIndex((entry) => entry.sourceEntry.id === messageEntryId);
  if (newest < 0) return -1;
  const entry = entries[newest];
  if (entry.sourceEntry.type !== "message") return -1;
  if (!entry.messages.some((message) => roleOf(message) === "assistant")) return -1;
  return newest;
}

/**
 * Choose the cut point so the retained tail fits the budget-derived tail target.
 * Returns undefined when nothing safe and worthwhile can be compacted.
 */
export function planBudgetedCompaction(input: BudgetedPlanInput): BudgetedPlan | undefined {
  const { entries, budget } = input;
  const estimate = input.estimate ?? defaultEstimate;
  if (entries.length === 0) return undefined;

  const newest = findNewestAssistant(entries, input.messageEntryId);
  if (newest < 0) return undefined;

  const overhead = Math.max(0, Math.floor(input.fixedOverheadTokens ?? 0));
  let tailBudget = budget.postCompactionTarget - overhead - budget.summaryBudget;
  let exception: BudgetedPlan["exception"];

  if (tailBudget < budget.tailMin) {
    // Protected content does not fit the soft target: fall back to the hard
    // capacity allowance so the next request can still be sent.
    const capacityTail = budget.inputAllowance - overhead - budget.summaryBudget;
    if (capacityTail < budget.tailMin) return undefined;
    tailBudget = capacityTail;
    exception = "capacity";
  }
  tailBudget = Math.min(tailBudget, budget.tailMax);

  let cut = newest;
  for (let i = newest - 1; i >= 0 && sumEntries(entries.slice(cut), estimate) < tailBudget; i--) {
    const entry = entries[i];
    if (entry.sourceEntry.type !== "message") continue;
    const hasConversation = entry.messages.some((message) => {
      const role = roleOf(message);
      return role === "user" || role === "assistant";
    });
    if (!hasConversation) continue;
    // An oversized older message belongs in the summary, not in an oversized tail.
    if (sumEntries(entries.slice(i), estimate) > tailBudget) break;
    cut = i;
  }

  if (cut <= 0) return undefined;

  const tail = entries.slice(cut);
  const prefix = entries.slice(0, cut);
  if (!hasCompleteToolPairs(tail) || !hasCompleteToolPairs(prefix)) return undefined;
  if (input.toolResultEntryIds?.some((id) => !tail.some((entry) => entry.sourceEntry.id === id))) {
    return undefined;
  }

  const prefixMessages = prefix
    .flatMap((entry) => [...entry.messages])
    .filter((message) => roleOf(message) !== "system");
  const prefixTokens = sumMessages(prefixMessages, estimate);
  const newTokens = sumMessages(
    prefixMessages.filter((message) => roleOf(message) !== "compactionSummary"),
    estimate,
  );

  // Do not repeatedly summarize an existing summary when little new work landed.
  if (newTokens < budget.minProgressTokens) return undefined;
  if (prefixTokens <= budget.summaryBudget) return undefined;

  return {
    cut,
    firstKeptEntryId: entries[cut].sourceEntry.id,
    prefixMessages,
    prefixTokens,
    newTokens,
    tailTokens: sumEntries(tail, estimate),
    tailBudget,
    fixedOverheadTokens: overhead,
    ...(exception ? { exception } : {}),
  };
}

export interface LegacyPlanInput {
  entries: readonly ProjectedEntryLike[];
  messageEntryId: string;
  toolResultEntryIds?: readonly string[];
  threshold: number;
  estimate?: MessageEstimator;
}

export interface LegacyPlan {
  cut: number;
  firstKeptEntryId: string;
  messages: unknown[];
  prefixTokens: number;
  newTokens: number;
  tailBudget: number;
}

/**
 * Exact reproduction of the pre-budget policy: tail = threshold/4 capped at 20k,
 * minimum progress = threshold/12 capped to [128, 4096].
 */
export function planLegacyCompaction(input: LegacyPlanInput): LegacyPlan | undefined {
  const { entries, threshold } = input;
  const estimate = input.estimate ?? defaultEstimate;
  const newest = findNewestAssistant(entries, input.messageEntryId);
  if (newest < 0) return undefined;

  const keepBudget = Math.min(20_000, Math.floor(threshold / 4));
  const minimumNewTokens = Math.max(128, Math.min(4096, Math.floor(threshold / 12)));

  let cut = newest;
  for (let i = newest - 1; i >= 0 && sumEntries(entries.slice(cut), estimate) < keepBudget; i--) {
    const entry = entries[i];
    if (entry.sourceEntry.type !== "message") continue;
    const hasConversation = entry.messages.some((message) => {
      const role = roleOf(message);
      return role === "user" || role === "assistant";
    });
    if (!hasConversation) continue;
    if (sumEntries(entries.slice(i), estimate) > keepBudget) break;
    cut = i;
  }
  if (cut <= 0) return undefined;

  const tail = entries.slice(cut);
  const prefix = entries.slice(0, cut);
  if (!hasCompleteToolPairs(tail) || !hasCompleteToolPairs(prefix)) return undefined;
  if (input.toolResultEntryIds?.some((id) => !tail.some((entry) => entry.sourceEntry.id === id))) {
    return undefined;
  }

  const messages = prefix
    .flatMap((entry) => [...entry.messages])
    .filter((message) => roleOf(message) !== "system");
  const prefixTokens = sumMessages(messages, estimate);
  const newTokens = sumMessages(
    messages.filter((message) => roleOf(message) !== "compactionSummary"),
    estimate,
  );
  if (prefixTokens < minimumNewTokens * 2 || newTokens < minimumNewTokens) return undefined;

  return {
    cut,
    firstKeptEntryId: entries[cut].sourceEntry.id,
    messages,
    prefixTokens,
    newTokens,
    tailBudget: keepBudget,
  };
}

export const DEFAULT_ESTIMATE_CHARS_PER_TOKEN = DEFAULT_CHARS_PER_TOKEN;
