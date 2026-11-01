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
} from "@earendil-works/pi-tui";
import {
  CustomEditor,
  type ExtensionAPI,
  type ExtensionContext,
  type ReadonlyFooterDataProvider,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { isSubagentChildSession } from "../subagent-context.ts";

/** Derive from the UI contract so this does not depend on a re-exported alias. */
type EditorFactory = NonNullable<ReturnType<ExtensionContext["ui"]["getEditorComponent"]>>;

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

/**
 * Patch the live editor so its top rule carries the model label.
 *
 * The editor slot is single-occupancy and shared with pi-paster, prompt-history
 * and `modes`. Patch the instance `renderTopBorder` instead of installing a
 * fresh `CustomEditor` subclass: replacing the slot drops every feature the
 * previous owner attached, which is how the mode switch key and image paste
 * silently disappeared when this extension loaded last.
 */
export function attachModelBorder<T extends object>(editor: T, label: () => string | undefined): T {
  const target = editor as T & {
    borderColor?: (text: string) => string;
    renderTopBorder?: (width: number, hiddenLineCount: number) => string;
  };
  if (typeof target.renderTopBorder !== "function") return editor;
  target.renderTopBorder = function (this: { borderColor?: (text: string) => string }, width: number, hiddenLineCount: number) {
    return renderModelTopBorder(label(), width, this.borderColor ?? ((text: string) => text), hiddenLineCount);
  };
  return editor;
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
    const barWidth = width >= 100 ? 20 : width >= 70 ? 12 : 8;
    const bar = contextBar(percent, barWidth);
    const split = bar.indexOf("░");
    const filled = split < 0 ? barWidth : split;
    const paintedBar = this.theme.fg(color, "█".repeat(filled))
      + this.theme.fg("dim", "░".repeat(barWidth - filled));

    const percentText = percent === null ? "?" : `${percent.toFixed(1)}%`;
    const used = tokens === null ? "?" : formatTokens(tokens);
    const total = window > 0 ? formatTokens(window) : "?";
    const remaining = tokens !== null && window > 0 ? Math.max(0, window - tokens) : null;
    const totals = this.usage(ctx);
    const consumption = usageLine(totals);

    const detail: string[] = [this.theme.fg("muted", `${used}/${total}`)];
    if (remaining !== null) detail.push(this.theme.fg("dim", `${formatTokens(remaining)} left`));
    if (consumption) detail.push(this.theme.fg("dim", consumption));
    if (totals.cost) detail.push(this.theme.fg("accent", `$${totals.cost.toFixed(3)}`));

    const label = this.theme.fg("dim", "ctx");
    const percentPaint = this.theme.fg(color, percentText);
    const line = `${label} ${this.theme.fg("dim", "[")}${paintedBar}${this.theme.fg("dim", "]")} ${percentPaint} ${this.theme.fg("dim", "·")} ${detail.join(this.theme.fg("dim", " · "))}`;
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
  let installedEditor: EditorFactory | undefined;
  let baseEditor: EditorFactory | undefined;

  const apply = (ctx: ExtensionContext) => {
    context = ctx;
    if (ctx.mode !== "tui" || isSubagentChildSession(ctx)) return;
    // Compose over whatever factory already owns the slot (pi-paster, prompt-history,
    // `modes`) so loading this extension never disables another one's editor.
    if (typeof ctx.ui.setEditorComponent === "function") {
      const previous = typeof ctx.ui.getEditorComponent === "function" ? ctx.ui.getEditorComponent() : undefined;
      if (previous !== installedEditor) baseEditor = previous;
      const base = baseEditor;
      installedEditor = (tui, editorTheme, keybindings) =>
        attachModelBorder(
          base?.(tui, editorTheme, keybindings) ?? new CustomEditor(tui, editorTheme, keybindings),
          () => modelLabel(context),
        );
      ctx.ui.setEditorComponent(installedEditor);
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
      installedEditor = undefined;
      baseEditor = undefined;
    }
  });
}
