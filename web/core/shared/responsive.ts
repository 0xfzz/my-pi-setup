// Shared responsive decision used by the client shell and pinned by tests.
// CSS cannot import TypeScript, so the matching media-query literals are
// asserted in tests/responsive-layout.test.ts.

export const COMPACT_VIEWPORT_WIDTH = 720;
export const SHORT_LANDSCAPE_HEIGHT = 500;

export type ViewportOrientation = "portrait" | "landscape";

/** Compact viewports use overlay panels instead of docked resizable panels. */
export function isCompactViewport(width: number, height: number, orientation: ViewportOrientation): boolean {
  return width <= COMPACT_VIEWPORT_WIDTH
    || (orientation === "landscape" && height <= SHORT_LANDSCAPE_HEIGHT);
}
