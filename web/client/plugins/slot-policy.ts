// Slot policy: how the host applies a plugin's declared placement. A plugin
// states what it needs through its ui contribution (strategy, bounds,
// collision); the host applies it, clamped to ceilings the host owns. So a
// plugin can ask for a one-line strip or a shorter card, never for more of the
// chat than the slot allows, and a view that outgrows its slot scrolls instead
// of pushing the composer off the screen.

import type { WebPluginDescriptor, WebPluginUiContribution, WebView } from "./contract.ts";

export type SlotPosition = "top" | "center" | "bottom" | "floating";
export type SlotCollision = "stack" | "shrink" | "hide";

/** Host ceilings: a placement hint can ask for less than these, never more. */
const BODY_HEIGHT_CEILING = 360;
const CARD_WIDTH_CEILING = 400;
const CENTER_BODY_HEIGHT = 240;
const FLOATING_BODY_HEIGHT = 380;
const FLOATING_CARD_WIDTH = 320;

export interface SlotPolicy {
  /** One summary line instead of the full view, whatever the slot. */
  compact: boolean;
  /** How the slot yields when the viewport is too small for it. */
  collision: SlotCollision;
  /** Height ceiling for a card body; taller views scroll inside it. */
  bodyMaxHeight: number;
  /** Width ceiling for a floating card. */
  cardMaxWidth: number;
}

function findRegionContribution(
  plugin: WebPluginDescriptor,
  slot: SlotPosition,
): WebPluginUiContribution | undefined {
  return plugin.ui?.find(
    (contribution) => contribution.placement.kind === "region" && contribution.placement.region === slot,
  );
}

function clampBound(hint: number | undefined, fallback: number, ceiling: number): number {
  return hint === undefined ? fallback : Math.min(hint, ceiling);
}

function defaultBodyHeight(slot: SlotPosition): number {
  return slot === "floating" ? FLOATING_BODY_HEIGHT : CENTER_BODY_HEIGHT;
}

export function slotPolicy(plugin: WebPluginDescriptor, slot: SlotPosition): SlotPolicy {
  const contribution = findRegionContribution(plugin, slot);
  const placement = contribution?.placement;
  return {
    compact: contribution?.strategy === "compact",
    collision: placement?.collision ?? "stack",
    bodyMaxHeight: clampBound(placement?.maxHeight, defaultBodyHeight(slot), BODY_HEIGHT_CEILING),
    cardMaxWidth: clampBound(placement?.maxWidth, FLOATING_CARD_WIDTH, CARD_WIDTH_CEILING),
  };
}

/** The one-line summary a compact slot shows for a view. */
export function compactSummary(view: WebView): string {
  if (view.type === "status") return view.text;
  if (view.type === "kv") {
    const first = view.rows[0];
    return first === undefined ? "" : `${first.label}: ${first.value}`;
  }
  if (view.type === "list") {
    const count = `${view.items.length} ${view.items.length === 1 ? "item" : "items"}`;
    const first = view.items[0];
    if (first === undefined) return count;
    return `${count} (${typeof first === "string" ? first : first.text})`;
  }
  if (view.type === "graph") {
    return `${view.nodes.length} ${view.nodes.length === 1 ? "node" : "nodes"}`;
  }
  return "";
}
