/**
 * Prompt chrome: model label in the editor's top border and a more explainable footer.
 *
 * Pi's stock footer puts the model on the far right and crams context usage into
 * `27.5%/1.0M`. This module embeds the model/provider/variant in the prompt
 * border and renders a labeled context bar with used/window/remaining tokens,
 * while keeping the cumulative token/cost stats and extension statuses.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type KeybindingsManager,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { isSubagentChildSession } from "./subagent-context.ts";

export interface ContextUsageLike {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  cacheHitRate?: number;
}

const EMPTY_USAGE: UsageTotals = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: 0,
};

/** Compact token counts matching Pi's own footer vocabulary. */
export function formatTokens(count: number): string {
  if (!Number.isFinite(count) || count <= 0) return "0";
  if (count < 1000) return `${Math.round(count)}`;
  if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
  if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  return `${Math.round(count / 1_000_000)}M`;
}

/** `████░░░░` bar, always exactly `width` cells. */
export function contextBar(percent: number | null, width: number): string {
  const cells = Math.max(1, Math.floor(width));
  if (percent === null || !Number.isFinite(percent)) return "░".repeat(cells);
  const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
  return "█".repeat(filled) + "░".repeat(cells - filled);
}

export function contextColor(percent: number | null): "success" | "warning" | "error" | "dim" {
  if (percent === null || !Number.isFinite(percent)) return "dim";
  if (percent > 90) return "error";
  if (percent > 70) return "warning";
  return "success";
}

/** Replace the home prefix with `~`, preserving the rest of the path. */
export function formatCwd(cwd: string, home = process.env.HOME || process.env.USERPROFILE): string {
  if (!home) return cwd;
  const resolvedCwd = resolve(cwd);
  const resolvedHome = resolve(home);
  const rel = relative(resolvedHome, resolvedCwd);
  const inside = rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
  if (!inside) return cwd;
  return rel === "" ? "~" : `~${sep}${rel}`;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: UsageTotals, usage: any): void {
  if (!usage || typeof usage !== "object") return;
  totals.input += num(usage.input);
  totals.output += num(usage.output);
  totals.cacheRead += num(usage.cacheRead);
  totals.cacheWrite += num(usage.cacheWrite);
  totals.cost += num(usage.cost);
}

/** Cumulative usage across the session, including compactions and tool results. */
export function collectUsage(entries: readonly any[]): UsageTotals {
  const totals: UsageTotals = { ...EMPTY_USAGE };
  for (const entry of entries) {
    if (entry?.type === "usage") {
      addUsage(totals, entry.usage);
    } else if (entry?.type === "message" && entry.message?.role === "assistant") {
      const usage = entry.message.usage;
      addUsage(totals, usage);
      const prompt = num(usage?.input) + num(usage?.cacheRead) + num(usage?.cacheWrite);
      if (prompt > 0) totals.cacheHitRate = (num(usage?.cacheRead) / prompt) * 100;
    } else if (entry?.type === "message" && entry.message?.role === "toolResult") {
      addUsage(totals, entry.message.usage);
    } else if ((entry?.type === "branch_summary" || entry?.type === "compaction") && entry.usage) {
      addUsage(totals, entry.usage);
    }
  }
  return totals;
}

function usageLine(totals: UsageTotals): string {
  const parts: string[] = [];
  if (totals.input) parts.push(`↑${formatTokens(totals.input)}`);
  if (totals.output) parts.push(`↓${formatTokens(totals.output)}`);
  if (totals.cacheRead) parts.push(`R${formatTokens(totals.cacheRead)}`);
  if (totals.cacheWrite) parts.push(`W${formatTokens(totals.cacheWrite)}`);
  if (totals.cacheHitRate !== undefined && (totals.cacheRead > 0 || totals.cacheWrite > 0)) {
    parts.push(`CH${totals.cacheHitRate.toFixed(1)}%`);
  }
  if (totals.cost) parts.push(`$${totals.cost.toFixed(3)}`);
  return parts.join(" ");
}

/**
 * `deepseek-v4.1-flash · opencode-go · high`, or undefined when no model is set.
 */
export function modelLabel(ctx: ExtensionContext | undefined): string | undefined {
  const model = ctx?.model;
  if (!model) return undefined;
  const variant = model.reasoning && ctx?.thinkingLevel ? ctx.thinkingLevel : undefined;
  return [model.id, model.provider, variant].filter(Boolean).join(" · ");
}

/**
 * Model label embedded in the editor's top rule:
 * `── deepseek-v4.1-flash · opencode-go · high ────────────`
 */
export function renderModelTopBorder(
  label: string | undefined,
  width: number,
  borderColor: (text: string) => string,
  hiddenLineCount = 0,
): string {
  const safeWidth = Math.max(1, Math.floor(width));
  const prefix = "── ";
  const gap = " ";
  const suffix = hiddenLineCount > 0 ? ` ↑${hiddenLineCount} ` : "";
  const budget = safeWidth - visibleWidth(prefix) - visibleWidth(gap) - visibleWidth(suffix);

  if (!label || budget < 4) {
    const fallback = hiddenLineCount > 0
      ? `↑${hiddenLineCount} ${"─".repeat(Math.max(0, safeWidth - String(hiddenLineCount).length - 2))}`
      : "─".repeat(safeWidth);
    return borderColor(truncateToWidth(fallback, safeWidth, ""));
  }

  const fitted = truncateToWidth(label, budget, "…");
  const fill = Math.max(0, safeWidth - visibleWidth(prefix) - visibleWidth(fitted) - visibleWidth(gap) - visibleWidth(suffix));
  return borderColor(prefix) + fitted + borderColor(gap + "─".repeat(fill)) + borderColor(suffix);
}

/** Editor whose top rule carries the live model/provider/thinking label. */
export class ModelBorderEditor extends CustomEditor {
  private readonly label: () => string | undefined;

  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    label: () => string | undefined,
  ) {
    super(tui, theme, keybindings);
    this.label = label;
  }

  protected override renderTopBorder(width: number, hiddenLineCount: number): string {
    return renderModelTopBorder(this.label(), width, this.borderColor, hiddenLineCount);
  }
}

/**
 * Footer with a labeled context bar and the cumulative token/cost line.
 */
export class ContextFooter implements Component {
  private readonly context: () => ExtensionContext | undefined;
  private readonly theme: Theme;
  private readonly footerData: ReadonlyFooterDataProvider;
  private cachedKey = "";
  private cachedUsage: UsageTotals = { ...EMPTY_USAGE };

  constructor(
    context: () => ExtensionContext | undefined,
    theme: Theme,
    footerData: ReadonlyFooterDataProvider,
  ) {
    this.context = context;
    this.theme = theme;
    this.footerData = footerData;
  }

  invalidate(): void {
    this.cachedKey = "";
  }

  dispose(): void {
    /* nothing to release */
  }

  render(width: number): string[] {
    const ctx = this.context();
    if (!ctx) return [];
    try {
      const lines: string[] = [];
      const branch = this.footerData.getGitBranch();
      const sessionName = ctx.sessionManager.getSessionName();
      let location = formatCwd(ctx.sessionManager.getCwd());
      if (branch) location += ` (${branch})`;
      if (sessionName) location += ` • ${sessionName}`;
      lines.push(this.theme.fg("dim", truncateToWidth(location, width, this.theme.fg("dim", "…"))));

      lines.push(this.renderContextLine(ctx, width));

      const usage = this.usage(ctx);
      const stats = usageLine(usage);
      if (stats) {
        lines.push(this.theme.fg("dim", truncateToWidth(stats, width, this.theme.fg("dim", "…"))));
      }

      const statuses = [...this.footerData.getExtensionStatuses().entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([, text]) => text.replace(/[\r\n\t]+/g, " ").replace(/ +/g, " ").trim())
        .filter(Boolean);
      if (statuses.length) {
        lines.push(truncateToWidth(statuses.join(" "), width, this.theme.fg("dim", "…")));
      }
      return lines;
    } catch {
      return [this.theme.fg("dim", "context usage unavailable")];
    }
  }

  private renderContextLine(ctx: ExtensionContext, width: number): string {
    const usage = ctx.getContextUsage() as ContextUsageLike | undefined;
    const model = ctx.model;
    const window = usage?.contextWindow ?? model?.contextWindow ?? 0;
    const tokens = usage?.tokens ?? null;
    const percent = usage?.percent
      ?? (tokens !== null && window > 0 ? (tokens / window) * 100 : null);
    const color = contextColor(percent);
    const barWidth = width >= 100 ? 24 : width >= 70 ? 16 : 10;
    const bar = contextBar(percent, barWidth);
    const paintedBar = this.theme.fg(color, "█".repeat(bar.indexOf("░") < 0 ? barWidth : bar.indexOf("░")))
      + this.theme.fg("dim", "░".repeat(bar.indexOf("░") < 0 ? 0 : barWidth - bar.indexOf("░")));

    const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
    const used = tokens === null ? "?" : formatTokens(tokens);
    const total = window > 0 ? formatTokens(window) : "?";
    const remaining = tokens !== null && window > 0 ? Math.max(0, window - tokens) : null;
    const detail = remaining === null
      ? `${used} / ${total}`
      : `${used} used · ${formatTokens(remaining)} left · ${total} window`;

    const label = this.theme.fg("dim", "context");
    const percentPaint = this.theme.fg(color, percentText);
    const detailPaint = this.theme.fg("muted", detail);
    const line = `${label} [${paintedBar}] ${percentPaint}  ${detailPaint}`;
    return truncateToWidth(line, width, this.theme.fg("dim", "…"));
  }

  private usage(ctx: ExtensionContext): UsageTotals {
    const manager: any = ctx.sessionManager;
    const entries = manager.getEntries();
    const key = `${manager.getLeafId?.() ?? ""}:${entries.length}:${ctx.model?.id ?? ""}`;
    if (key !== this.cachedKey) {
      this.cachedKey = key;
      this.cachedUsage = collectUsage(entries);
    }
    return this.cachedUsage;
  }
}

/** Install the model border and context footer for TUI parent sessions. */
export default function promptUi(pi: ExtensionAPI) {
  let context: ExtensionContext | undefined;
  let installed = false;

  const apply = (ctx: ExtensionContext) => {
    context = ctx;
    if (ctx.mode !== "tui" || isSubagentChildSession(ctx)) return;
    // Replacing the editor keeps the model in the prompt's own top rule instead
    // of spending an extra row above it. CustomEditor preserves app keybindings
    // and only the top border changes.
    if (typeof ctx.ui.setEditorComponent === "function") {
      ctx.ui.setEditorComponent((tui, editorTheme, keybindings) =>
        new ModelBorderEditor(tui, editorTheme, keybindings, () => modelLabel(context)),
      );
    }
    if (typeof ctx.ui.setFooter === "function") {
      ctx.ui.setFooter((_tui, theme, footerData) => new ContextFooter(() => context, theme, footerData));
    }
    installed = true;
  };

  pi.on("session_start", (_event, ctx) => apply(ctx));
  pi.on("session_tree", (_event, ctx) => apply(ctx));
  pi.on("before_agent_start", (_event, ctx) => { context = ctx; });

  pi.on("session_shutdown", () => {
    if (!installed || !context) return;
    try {
      context.ui.setEditorComponent(undefined);
      context.ui.setFooter(undefined);
    } finally {
      context = undefined;
      installed = false;
    }
  });
}
