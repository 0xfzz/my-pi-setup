// Anchor policy: which plugin views mount at one named anchor, in what order.
//
// An anchor is a named spot the host owns (`chat.composer`, `session.header`, …).
// A plugin asks for it with a `ui[]` contribution whose placement is
// `{ kind: "anchor" }`. Everything here is a pure decision over the descriptor
// list, the published views and the session's running flag — no React, no DOM —
// so the mounting rules are unit-tested without a browser.

import type { WebPluginDescriptor, WebPluginUiContribution, WebView } from "./contract.ts";
import type { WebUiAnchor } from "../../plugin-contracts/ui-contracts.ts";

/** One view to mount: the plugin, the contribution that placed it, and the view. */
export interface AnchorEntry {
  pluginId: string;
  title: string;
  contribution: WebPluginUiContribution;
  view: WebView;
}

export interface AnchorQuery {
  anchor: WebUiAnchor;
  /** Mid-turn right now; drives `visibleWhen: "running" | "idle"`. */
  running?: boolean;
  /**
   * Plugin ids whose published view is already rendered somewhere else — a
   * region override that won the region, or a panel. A plugin never renders
   * the same view twice.
   */
  suppressed?: ReadonlySet<string>;
}

function anchorOf(contribution: WebPluginUiContribution): WebUiAnchor | undefined {
  const placement = contribution.placement;
  if (placement.kind === "anchor") return placement.anchor;
  // An overlay anchored inside the content flow mounts like an anchor; one
  // without an anchor is a viewport overlay, not an anchor contribution.
  if (placement.kind === "overlay") return placement.anchor;
  return undefined;
}

function isVisible(contribution: WebPluginUiContribution, running: boolean): boolean {
  switch (contribution.visibleWhen) {
    case "running":
      return running;
    case "idle":
      return !running;
    default:
      return true;
  }
}

/** Placement order: explicit `order`, then higher priority, then plugin id. */
function compareEntries(a: AnchorEntry, b: AnchorEntry): number {
  const orderDelta = (a.contribution.placement.order ?? 0) - (b.contribution.placement.order ?? 0);
  if (orderDelta !== 0) return orderDelta;
  const priorityDelta = (b.contribution.priority ?? 0) - (a.contribution.priority ?? 0);
  if (priorityDelta !== 0) return priorityDelta;
  return a.pluginId.localeCompare(b.pluginId);
}

/**
 * The views to mount at `query.anchor`. A plugin contributes at most once per
 * anchor (its first matching contribution), needs a published non-dialog view,
 * and is skipped when it is suppressed elsewhere or its visibility says so.
 */
export function anchorEntries(
  plugins: readonly WebPluginDescriptor[],
  views: Record<string, WebView> | null | undefined,
  query: AnchorQuery,
): AnchorEntry[] {
  const running = query.running === true;
  const suppressed = query.suppressed ?? new Set<string>();
  const entries: AnchorEntry[] = [];
  for (const plugin of plugins) {
    if (suppressed.has(plugin.id)) continue;
    const view = views?.[plugin.id];
    if (view === undefined || view === null || view.type === "dialog") continue;
    const contribution = (plugin.ui ?? []).find(
      (candidate) => anchorOf(candidate) === query.anchor && isVisible(candidate, running),
    );
    if (contribution === undefined) continue;
    entries.push({ pluginId: plugin.id, title: plugin.title, contribution, view });
  }
  return entries.sort(compareEntries);
}

/**
 * Plugin ids whose view is already rendered by a winning region override, so
 * the same view is not mounted a second time at an anchor.
 */
export function regionOverrideOwners(
  regions: Partial<Record<string, { pluginId: string } | undefined>>,
): Set<string> {
  const owners = new Set<string>();
  for (const override of Object.values(regions)) {
    if (override !== undefined) owners.add(override.pluginId);
  }
  return owners;
}

/**
 * One published view renders once. The precedence is
 * region override → right-hand panel → anchor: an anchor is the additive
 * fallback, never a second copy of content the operator can already see.
 */
export function anchorSuppression(
  regionOwners: ReadonlySet<string>,
  panelPluginIds: Iterable<string>,
): Set<string> {
  return new Set([...regionOwners, ...panelPluginIds]);
}
