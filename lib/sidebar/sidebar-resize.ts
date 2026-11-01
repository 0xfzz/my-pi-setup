import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { SIDEBAR_MIN_WIDTH, SIDEBAR_MAX_WIDTH, sidebarWidth } from "./sidebar-layout.ts";

/** Only the divider owns gestures; transcript selection, scrolling and editor
 * focus are untouched. Use screen coordinates because capture retains the
 * original bounds even after the divider moves. Deduplicate redundant column
 * updates to keep resizing butter-smooth. */
export class SidebarResizer {
  dragging = false;
  private startX = 0;
  private moved = false;
  private lastWidth = 0;
  private pendingWidth?: number;
  private throttleTimer?: ReturnType<typeof setTimeout>;
  private readonly columns: () => number;
  private readonly available: () => boolean;
  private readonly resize: (width: number) => void;
  private readonly onDragStart?: () => void;
  private readonly onDragEnd?: () => void;
  private readonly throttleMs: number;

  constructor(
    columns: () => number,
    available: () => boolean,
    resize: (width: number) => void,
    onDragStart?: () => void,
    onDragEnd?: () => void,
    throttleMs = 0
  ) {
    this.columns = columns;
    this.available = available;
    this.resize = resize;
    this.onDragStart = onDragStart;
    this.onDragEnd = onDragEnd;
    this.throttleMs = throttleMs;
  }

  cancel(): void {
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = undefined;
    }
    this.pendingWidth = undefined;
    if (this.dragging) {
      this.dragging = false;
      this.lastWidth = 0;
      this.onDragEnd?.();
    }
  }

  handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
    if (!this.available()) { this.cancel(); return; }
    if (event.type === "press" && event.button === "left" && event.x === 0 && !event.shift && !event.alt && !event.ctrl) {
      this.dragging = true;
      this.startX = event.screenX;
      this.moved = false;
      this.lastWidth = 0;
      this.pendingWidth = undefined;
      this.onDragStart?.();
      return { capture: true, render: true };
    }
    if (!this.dragging) return;
    if (event.type === "drag" || event.type === "release") {
      this.moved ||= event.screenX !== this.startX;
      let changed = false;
      if (this.moved) {
        const width = sidebarWidth(this.columns(), Math.min(SIDEBAR_MAX_WIDTH, this.columns() - event.screenX));
        const clamped = Math.max(SIDEBAR_MIN_WIDTH, width);
        if (clamped !== this.lastWidth) {
          this.lastWidth = clamped;
          this.pendingWidth = clamped;
          if (this.throttleMs <= 0) {
            this.resize(clamped);
            changed = true;
          } else if (!this.throttleTimer) {
            this.resize(clamped);
            changed = true;
            this.throttleTimer = setTimeout(() => {
              this.throttleTimer = undefined;
              if (this.pendingWidth !== undefined && this.pendingWidth !== this.lastWidth) {
                const target = this.pendingWidth;
                this.pendingWidth = undefined;
                this.resize(target);
              }
            }, this.throttleMs);
            this.throttleTimer.unref?.();
          }
        }
      }
      if (event.type === "release") {
        if (this.throttleTimer) {
          clearTimeout(this.throttleTimer);
          this.throttleTimer = undefined;
        }
        if (this.pendingWidth !== undefined && this.pendingWidth !== this.lastWidth) {
          this.resize(this.pendingWidth);
          this.pendingWidth = undefined;
        }
        this.cancel();
        return { handled: true, render: true };
      }
      return { handled: true, render: changed };
    }
    // Recover if a terminal reports motion without a button after losing release.
    if (event.type === "move" && event.button === "none") {
      this.cancel();
      return { handled: true, render: true };
    }
  }
}
