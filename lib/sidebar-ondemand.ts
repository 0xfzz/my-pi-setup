import type { Component, Container, ScrollView } from "@earendil-works/pi-tui";

export interface OnDemandOptions {
  /** Extra line buffer above and below the visible viewport (default: 25) */
  bufferLines?: number;
  /** Minimum children before on-demand optimization kicks in (default: 12) */
  threshold?: number;
}

/**
 * Wraps a Container's render() method so that messages/components far outside
 * the visible ScrollView viewport reuse their previously formatted/rendered lines.
 * Only messages intersecting the visible window [scrollTop - buffer, scrollTop + viewportHeight + buffer]
 * are re-wrapped on demand when column width changes.
 *
 * This turns an O(N) full-transcript markdown word-wrapping bottleneck into
 * an O(1) viewport-only operation during resizing and scrolling.
 */
export class OnDemandContainer {
  readonly container: Container;
  private readonly getScrollView: () => ScrollView | undefined;
  private readonly options: OnDemandOptions;
  private readonly originalRender: (width: number) => string[];
  private readonly lineCache = new WeakMap<Component, { width: number; lines: string[] }>();
  private active = true;

  constructor(
    container: Container,
    getScrollView: () => ScrollView | undefined,
    options: OnDemandOptions = {}
  ) {
    this.container = container;
    this.getScrollView = getScrollView;
    this.options = options;
    this.originalRender = container.render.bind(container);
  }

  install(): () => void {
    const original = this.originalRender;
    const threshold = this.options.threshold ?? 12;
    const buffer = this.options.bufferLines ?? 25;

    this.container.render = (width: number): string[] => {
      if (!this.active) return original(width);
      const sv = this.getScrollView();
      const children = this.container.children;

      // If history is small or no scrollview is available, use native render
      if (!sv || children.length < threshold) {
        return original(width);
      }

      const lines: string[] = [];
      const mouseChildren: Array<{ component: Component; height: number }> = [];

      const viewportH = sv.viewportHeight || 34;
      const isFollowing = sv.isFollowingEnd;

      // 1. Gather heights from cache or estimate
      let totalEstimatedHeight = 0;
      const childHeights: number[] = Array.from({ length: children.length });
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const cached = this.lineCache.get(child);
        const h = cached ? cached.lines.length : 1;
        childHeights[i] = h;
        totalEstimatedHeight += h;
      }

      // 2. Compute visible window
      const scrollTop = isFollowing ? Math.max(0, totalEstimatedHeight - viewportH) : sv.scrollTop;
      const visibleStart = Math.max(0, scrollTop - buffer);
      const visibleEnd = scrollTop + viewportH + buffer;

      // 3. Render children: visible ones are formatted on demand; offscreen reuse cache
      let currentY = 0;
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        const h = childHeights[i];
        const childStart = currentY;
        const childEnd = currentY + h;
        currentY += h;

        const isVisible = childEnd >= visibleStart && childStart <= visibleEnd;
        const cached = this.lineCache.get(child);

        let childLines: string[];
        if (isVisible || !cached) {
          childLines = child.render(width);
          this.lineCache.set(child, { width, lines: childLines });
        } else {
          // Offscreen: reuse cached lines without re-wrapping
          childLines = cached.lines;
        }

        mouseChildren.push({ component: child, height: childLines.length });
        for (const line of childLines) {
          lines.push(line);
        }
      }

      Reflect.set(this.container, "mouseLayout", { width, children: mouseChildren });
      return lines;
    };

    return () => {
      this.active = false;
      this.container.render = original;
    };
  }
}
