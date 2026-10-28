/**
 * Model-aware VCC auto-compaction controller.
 *
 * Policy summary (see docs/VCC-AUTO-COMPACT.md):
 *   - a model profile supplies a calibrated quality target when one exists
 *   - otherwise a documented fallback target is used and marked uncalibrated
 *   - the retained tail is derived from the post-compaction target, not trigger/4
 *   - summaries are packed to a real token budget
 *   - successful tool observations are carried forward as bounded evidence
 *   - the resulting whole request is verified before the boundary draft is returned
 *
 * `mode: "legacy"` reproduces the previous behaviour byte for byte.
 */

import { convertToLlm } from "@earendil-works/pi-coding-agent";
import type {
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  TurnEndEvent,
} from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import {
  describeBudget,
  resolveBudget,
  type ContextBudget,
} from "./budget.ts";
import {
  defaultConfigPath,
  defaultTelemetryPath,
  normalizeAutoCompactConfig,
  resolvePolicyMode,
  resolveProfile,
  type AutoCompactConfig,
} from "./config.ts";
import { estimateMessageTokens } from "./estimate.ts";
import { extractEvidence, insertEvidence } from "./evidence.ts";
import {
  estimateFixedOverhead,
  planBudgetedCompaction,
  planLegacyCompaction,
  type MessageEstimator,
} from "./plan.ts";
import { packSummary, SUMMARY_SEPARATOR } from "./summary-budget.ts";
import { appendTelemetry, readTelemetry, TELEMETRY_VERSION, type CompactionTelemetryRecord } from "./telemetry.ts";

export type { AutoCompactConfig } from "./config.ts";
export { describeBudget, resolveBudget } from "./budget.ts";
export { hasCompleteToolPairs } from "./plan.ts";

export interface CompileSummaryInput {
  messages: unknown[];
  previousSummary?: string;
}

export type CompileSummary = (input: CompileSummaryInput) => Promise<string>;

export interface RegisterOptions {
  readConfig?: () => AutoCompactConfig;
  /** The pi-vcc compiler. Injected so tests never touch the installed package. */
  compileSummary: CompileSummary;
  /** Recall note appended by the compiler; treated as protected summary content. */
  recallNote?: string;
  /** Overrides the telemetry destination (tests). */
  telemetryPath?: string;
}

const nowIso = () => new Date().toISOString();

/** Parse the `autoCompact` block from the shared pi-vcc config. */
export function loadConfig(): AutoCompactConfig {
  const configPath = defaultConfigPath();
  try {
    const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    return normalizeAutoCompactConfig(parsed.autoCompact);
  } catch {
    return {};
  }
}

function telemetryPathFor(config: AutoCompactConfig, override?: string): string {
  if (override) return override;
  if (config.telemetry?.path) return config.telemetry.path;
  return defaultTelemetryPath(defaultConfigPath());
}

const isEnabled = (config: AutoCompactConfig): boolean => config.enabled !== false;

/**
 * Legacy-compatible planner export.
 * Kept because external tests and callers use `planCompaction(event, threshold)`.
 */
export function planCompaction(event: TurnEndEvent, threshold: number) {
  const plan = planLegacyCompaction({
    entries: event.context.contextEntries,
    messageEntryId: event.messageEntryId,
    toolResultEntryIds: event.toolResultEntryIds,
    threshold,
  });
  if (!plan) return undefined;
  return {
    messages: plan.messages,
    prefixTokens: plan.prefixTokens,
    firstKeptEntryId: plan.firstKeptEntryId,
  };
}

interface BudgetedAttempt {
  budget: ContextBudget;
  record: CompactionTelemetryRecord;
  summary?: string;
  firstKeptEntryId?: string;
  plan: NonNullable<ReturnType<typeof planBudgetedCompaction>>;
  detail: Record<string, unknown>;
}

const k = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

export function registerAutoCompact(pi: ExtensionAPI, options: RegisterOptions) {
  const readConfig = options.readConfig ?? loadConfig;
  const compileSummary = options.compileSummary;
  const estimate: MessageEstimator = (message) => estimateMessageTokens(message);
  let busy = false;
  let sessionId: string | undefined;
  let failuresToSkip = 0;
  let shadowNotified = false;

  async function record(config: AutoCompactConfig, entry: CompactionTelemetryRecord) {
    if (config.telemetry?.enabled === false) return;
    await appendTelemetry(telemetryPathFor(config, options.telemetryPath), entry);
  }

  pi.on("turn_end", async (event, ctx: ExtensionContext) => {
    const currentSession = ctx.sessionManager.getSessionId();
    if (sessionId !== currentSession) {
      sessionId = currentSession;
      failuresToSkip = 0;
      shadowNotified = false;
    }
    if (busy || event.outcome !== "completed" || ctx.signal?.aborted) return;
    if (failuresToSkip > 0) {
      failuresToSkip--;
      return;
    }
    const config = readConfig();
    if (!isEnabled(config)) return;
    // getContextUsage is authoritative for committed context. Plain custom
    // metadata is harmless; never mix staged context changes or preview IDs.
    if (event.entries.some((entry) => entry.type !== "custom")) return;
    const usage = ctx.getContextUsage();
    if (!usage || usage.tokens === null || !Number.isFinite(usage.tokens) ||
        !Number.isFinite(usage.contextWindow) || usage.contextWindow <= 0 || !ctx.model) return;

    const mode = resolvePolicyMode(config);
    const model = ctx.model as { provider?: string; id?: string; maxTokens?: number };
    const startedAt = Date.now();

    if (mode === "legacy") {
      const percent = config.maxPercent ?? 20;
      if (!Number.isFinite(percent) || percent <= 0 || percent >= 100) return;
      const threshold = usage.contextWindow * percent / 100;
      if (usage.tokens < threshold) return;
      const plan = planCompaction(event, threshold);
      if (!plan) return;

      const leafId = ctx.sessionManager.getLeafId();
      busy = true;
      try {
        if (ctx.hasUI) ctx.ui.setStatus("auto-compact", `pi-vcc compacting (${percent}% trigger)…`);
        const previousSummary = plan.messages
          .filter((message) => (message as { role?: string }).role === "compactionSummary")
          .map((message) => (message as { summary?: string }).summary ?? "")
          .join("\n\n") || undefined;
        const messages = convertToLlm(
          plan.messages.filter((message) => (message as { role?: string }).role !== "compactionSummary") as never,
        );
        const summary = (await compileSummary({
          messages: messages as unknown[],
          previousSummary,
        })).trim();

        if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== currentSession ||
            ctx.sessionManager.getLeafId() !== leafId) return;
        if (!summary) throw new Error("pi-vcc summary was empty");
        const summaryTokens = Math.ceil(summary.length / 4);
        if (summaryTokens >= plan.prefixTokens - Math.min(1024, threshold / 100)) {
          throw new Error("Summary would not reduce context enough");
        }
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
      return;
    }

    // ── budgeted mode ──
    const profileInfo = resolveProfile(config, model.provider, model.id);
    const budget = resolveBudget({
      contextWindow: usage.contextWindow,
      modelMaxOutputTokens: model.maxTokens,
      profile: profileInfo.profile,
      defaults: config.defaults,
    });
    if (!budget) return;

    const baseRecord: Omit<CompactionTelemetryRecord, "outcome"> = {
      ts: nowIso(),
      version: TELEMETRY_VERSION,
      mode: "budgeted",
      provider: model.provider,
      model: model.id,
      contextWindow: budget.contextWindow,
      calibrated: budget.calibrated,
      ...(profileInfo.key ? { profileKey: profileInfo.key } : {}),
      usageTokens: usage.tokens,
      triggerTokens: budget.qualityTarget,
      inputAllowance: budget.inputAllowance,
      qualityTarget: budget.qualityTarget,
      postCompactionTarget: budget.postCompactionTarget,
      summaryBudget: budget.summaryBudget,
    };

    if (usage.tokens < budget.qualityTarget) return;

    const entries: readonly ProjectedSessionEntry[] = event.context.contextEntries;
    const pending = (event.context as { pendingMessages?: unknown[] }).pendingMessages ?? [];
    const overhead = estimateFixedOverhead(entries, pending, estimate);
    const plan = planBudgetedCompaction({
      entries,
      messageEntryId: event.messageEntryId,
      toolResultEntryIds: event.toolResultEntryIds,
      budget,
      fixedOverheadTokens: overhead.tokens,
      estimate,
    });
    if (!plan) {
      await record(config, {
        ...baseRecord,
        outcome: "skipped",
        reason: "no-safe-cut",
        fixedOverheadTokens: overhead.tokens,
      });
      return;
    }

    const leafId = ctx.sessionManager.getLeafId();
    busy = true;
    const attempt: BudgetedAttempt = {
      budget,
      plan,
      record: {
        ...baseRecord,
        outcome: "skipped",
        tailBudget: plan.tailBudget,
        tailTokens: plan.tailTokens,
        prefixTokens: plan.prefixTokens,
        newTokens: plan.newTokens,
        fixedOverheadTokens: overhead.tokens,
        ...(plan.exception ? { exception: plan.exception } : {}),
      },
      detail: {},
    };

    try {
      if (ctx.hasUI) {
        ctx.ui.setStatus(
          "auto-compact",
          `pi-vcc compacting (${k(budget.qualityTarget)} tok trigger${budget.calibrated ? ", calibrated" : ""})…`,
        );
      }
      const previousSummary = plan.prefixMessages
        .filter((message) => (message as { role?: string }).role === "compactionSummary")
        .map((message) => (message as { summary?: string }).summary ?? "")
        .join("\n\n") || undefined;
      const llmMessages = convertToLlm(
        plan.prefixMessages.filter(
          (message) => (message as { role?: string }).role !== "compactionSummary",
        ) as never,
      ) as unknown[];

      const rawSummary = (await compileSummary({
        messages: llmMessages,
        previousSummary,
      })).trim();
      if (!rawSummary) throw new Error("pi-vcc summary was empty");

      const evidence = extractEvidence(llmMessages, {
        maxTokens: budget.evidenceBudget,
        charsPerToken: budget.charsPerToken,
      });
      const withEvidence = insertEvidence(rawSummary, evidence.section, SUMMARY_SEPARATOR);
      const packed = packSummary(withEvidence, {
        budgetTokens: budget.summaryBudget,
        recallNote: options.recallNote,
        charsPerToken: budget.charsPerToken,
      });

      if (!packed.fits) {
        throw new Error(
          `Protected summary (${packed.protectedTokens} tok) exceeds the summary budget (${budget.summaryBudget} tok)`,
        );
      }

      if (ctx.signal?.aborted || ctx.sessionManager.getSessionId() !== currentSession ||
          ctx.sessionManager.getLeafId() !== leafId) return;

      // Verify the request that will actually be sent, not just the summary.
      const afterTokens = overhead.tokens + plan.tailTokens + packed.tokens;
      const reduction = usage.tokens - afterTokens;
      const minimumReduction = Math.max(128, Math.floor(usage.tokens * 0.05));
      const headroomSatisfied =
        afterTokens <= Math.ceil(budget.postCompactionTarget * budget.tuning.headroomToleranceRatio);

      attempt.summary = packed.text;
      attempt.firstKeptEntryId = plan.firstKeptEntryId;
      attempt.record = {
        ...attempt.record,
        summaryTokens: packed.tokens,
        evidenceTokens: evidence.tokens,
        evidenceItems: evidence.items,
        afterTokens,
        headroomSatisfied,
        durationMs: Date.now() - startedAt,
      };
      attempt.detail = {
        budget: {
          contextWindow: budget.contextWindow,
          inputAllowance: budget.inputAllowance,
          qualityTarget: budget.qualityTarget,
          postCompactionTarget: budget.postCompactionTarget,
          summaryBudget: budget.summaryBudget,
          calibrated: budget.calibrated,
        },
        tailBudget: plan.tailBudget,
        tailTokens: plan.tailTokens,
        fixedOverheadTokens: overhead.tokens,
        summaryTokens: packed.tokens,
        afterTokens,
        headroomSatisfied,
        evidenceTokens: evidence.tokens,
        ...(plan.exception ? { exception: plan.exception } : {}),
      };

      if (afterTokens > budget.inputAllowance) {
        throw new Error(
          `Compacted request (${afterTokens} tok) would still exceed capacity (${budget.inputAllowance} tok)`,
        );
      }
      if (reduction < minimumReduction) {
        throw new Error(
          `Summary would not reduce context enough (${reduction} tok saved, need ${minimumReduction})`,
        );
      }

      if (config.shadow === true) {
        await record(config, { ...attempt.record, outcome: "shadow" });
        if (ctx.hasUI && !shadowNotified) {
          shadowNotified = true;
          ctx.ui.notify(
            `VCC shadow: would compact at ${k(budget.qualityTarget)} tok → ${k(afterTokens)} tok ` +
              `(summary ${k(packed.tokens)}, tail ${k(plan.tailTokens)}).`,
            "info",
          );
        }
        return;
      }

      await record(config, { ...attempt.record, outcome: "committed" });

      return {
        entries: [...event.entries, {
          type: "compaction" as const,
          summary: packed.text,
          firstKeptEntryId: plan.firstKeptEntryId,
          details: {
            compactor: "pi-vcc",
            version: 1,
            policy: "budgeted",
            trigger: "turn_end",
            sourceMessageCount: llmMessages.length,
            previousSummaryUsed: Boolean(previousSummary),
            sections: [...packed.text.matchAll(/^\[(.+?)\]/gm)].map((match) => match[1]),
            ...attempt.detail,
          },
        }],
      };
    } catch (error) {
      failuresToSkip = 3;
      await record(config, {
        ...attempt.record,
        outcome: "skipped",
        reason: error instanceof Error ? error.message : String(error),
        durationMs: Date.now() - startedAt,
      });
      if (!ctx.signal?.aborted && ctx.hasUI) {
        ctx.ui.notify(
          `Auto-compaction skipped; history preserved: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    } finally {
      busy = false;
      if (ctx.hasUI) ctx.ui.setStatus("auto-compact", undefined);
    }
  });
}

/**
 * `/vcc-budget` — show the resolved budget for the current model and the most
 * recent compaction telemetry. Registered defensively: minimal test doubles for
 * `ExtensionAPI` may not implement commands.
 */
export function registerBudgetCommand(
  pi: ExtensionAPI,
  options: { readConfig?: () => AutoCompactConfig; telemetryPath?: string } = {},
) {
  const register = (pi as { registerCommand?: (name: string, definition: unknown) => void })
    .registerCommand;
  if (typeof register !== "function") return;
  const readConfig = options.readConfig ?? loadConfig;

  register.call(pi, "vcc-budget", {
    description: "Show the active VCC compaction budget and recent telemetry",
    handler: async (_args: string, ctx: ExtensionContext) => {
      const config = readConfig();
      const mode = resolvePolicyMode(config);
      const model = ctx.model as { provider?: string; id?: string; maxTokens?: number } | undefined;
      const usage = ctx.getContextUsage();
      const lines: string[] = [
        `model: ${model ? `${model.provider ?? "?"}/${model.id ?? "?"}` : "(none)"}`,
        `mode: ${mode}${config.shadow ? " · shadow (no commits)" : ""}`,
        `telemetry: ${config.telemetry?.enabled === false ? "off" : telemetryPathFor(config, options.telemetryPath)}`,
      ];

      if (mode === "legacy") {
        lines.push(`legacy trigger: ${config.maxPercent ?? 20}% of the context window`);
      } else if (usage) {
        const profile = resolveProfile(config, model?.provider, model?.id);
        const budget = resolveBudget({
          contextWindow: usage.contextWindow,
          modelMaxOutputTokens: model?.maxTokens,
          profile: profile.profile,
          defaults: config.defaults,
        });
        if (budget) {
          lines.push(describeBudget(budget));
          lines.push(
            `profile: ${profile.key ?? "(defaults)"} · ${budget.calibrated ? `calibrated (${budget.profileKey ?? "no source"})` : "uncalibrated fallback"}`,
          );
          lines.push(
            `now: ${usage.tokens === null ? "unknown" : `${k(usage.tokens)} tok`} · ` +
              `remaining to trigger: ${usage.tokens === null ? "?" : k(Math.max(0, budget.qualityTarget - usage.tokens))}`,
          );
        }
      } else {
        lines.push("context usage unavailable");
      }

      const recent = await readTelemetry(telemetryPathFor(config, options.telemetryPath), 5);
      if (recent.length === 0) {
        lines.push("recent: none");
      } else {
        lines.push("recent:");
        for (const entry of recent) {
          const when = entry.ts.slice(11, 19);
          const after = entry.afterTokens ? `→ ${k(entry.afterTokens)}` : "";
          const head = entry.headroomSatisfied === false ? " (no-headroom)" : "";
          lines.push(
            `  ${when} ${entry.outcome}${head} ${entry.calibrated ? "cal" : "est"} ` +
              `${entry.usageTokens ? k(entry.usageTokens) : "?"} ${after} ${entry.reason ?? ""}`.trimEnd(),
          );
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });
}
