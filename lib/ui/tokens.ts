/**
 * Design tokens shared by every extension popup.
 *
 * Keep layout decisions here instead of in call sites: a popup that hard-codes
 * `rows: 20` clips on a short terminal, and a popup that paints its own colors
 * drifts from the rest of the UI.
 */
import { POPUP_FRAME_ROWS, POPUP_MARGIN } from "../popup.ts";

/** Rows available inside the frame at a given terminal height. */
export function popupBodyRows(terminalRows: number, desired?: number): number {
  const safeTerminal = Number.isFinite(terminalRows) ? Math.max(8, Math.floor(terminalRows)) : 24;
  const available = Math.max(3, safeTerminal - POPUP_FRAME_ROWS - 2 * POPUP_MARGIN);
  if (desired === undefined) return available;
  const safeDesired = Number.isFinite(desired) ? Math.max(1, Math.floor(desired)) : available;
  return Math.max(1, Math.min(available, safeDesired));
}

/** Standard key hints; callers should not invent their own wording. */
export const KEY_HINT = {
  close: "Esc close",
  cancel: "Esc cancel",
  select: "Enter select",
  open: "Enter open",
  scroll: "↑↓ scroll",
  page: "PgUp/PgDn page",
  search: "type to filter",
  next: "n/N next/prev",
  editor: "o nvim",
} as const;
