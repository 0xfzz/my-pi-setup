import type { TUI } from "@earendil-works/pi-tui";
import { visibleWidth, sliceByColumn, stripTerminalSequences } from "@earendil-works/pi-tui";

export type SelectionRegionType = "sidebar" | "conversation" | "prompt";

export interface SelectionRegionBounds {
  type: SelectionRegionType;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
}

export interface SelectionBoundaryControllerOptions {
  enabled: () => boolean;
  width: () => number;
}

interface RawMouseEvent {
  x: number;
  y: number;
  button: number;
  release?: boolean;
  shift?: boolean;
  alt?: boolean;
  ctrl?: boolean;
}

/**
 * Isolates text selection between three distinct areas in Pi:
 * 1. Sidebar: selections starting in the sidebar stay within the sidebar rail.
 * 2. Conversation: selections starting in the chat transcript stay within the conversation container.
 * 3. Prompt input: selections starting in the dock/editor stay within the prompt box.
 *
 * Coordinates are clamped during mouse drag, visual highlight styling is constrained to the region,
 * and text extraction for copying to clipboard is clipped to the region bounds.
 */
export class SelectionBoundaryController {
  private readonly tui: TUI;
  private readonly enabled: () => boolean;
  private readonly width: () => number;
  private activeRegion?: SelectionRegionBounds;
  private originalHandleSelectionMouseEvent?: (event: RawMouseEvent) => void;
  private originalApplySelection?: (screen: string[], layout?: any) => string[];
  private originalGetActiveSelectionText?: () => string | undefined;
  private active = false;

  constructor(tui: TUI, options: SelectionBoundaryControllerOptions) {
    this.tui = tui;
    this.enabled = options.enabled;
    this.width = options.width;
  }

  getActiveRegion(): SelectionRegionBounds | undefined {
    return this.activeRegion;
  }

  resolveRegion(x: number, y: number): SelectionRegionBounds {
    const cols = Math.max(1, this.tui.terminal.columns);
    const rows = Math.max(1, this.tui.terminal.rows);
    const sideActive = this.enabled() && cols >= 100;
    const sideWidth = sideActive ? Math.max(20, Math.min(cols - 76, this.width())) : 0;
    const sideX = cols - sideWidth;
    const dockY = this.getDockY(rows);

    if (sideWidth > 0 && x >= sideX) {
      return {
        type: "sidebar",
        minX: sideX,
        maxX: cols - 1,
        minY: 0,
        maxY: rows - 1,
      };
    }

    if (y < dockY) {
      return {
        type: "conversation",
        minX: 0,
        maxX: sideWidth > 0 ? sideX - 1 : cols - 1,
        minY: 0,
        maxY: Math.max(0, dockY - 1),
      };
    }

    return {
      type: "prompt",
      minX: 0,
      maxX: sideWidth > 0 ? sideX - 1 : cols - 1,
      minY: dockY,
      maxY: rows - 1,
    };
  }

  private getDockY(rows: number): number {
    try {
      const layout = Reflect.get(this.tui, "currentLayout");
      const sv = typeof (this.tui as any).getPrimaryScrollView === "function"
        ? (this.tui as any).getPrimaryScrollView()
        : Reflect.get(this.tui, "implicitScrollView");
      if (layout && sv) {
        const box = this.findBoxForComponent(layout, sv);
        if (box?.rect && box.rect.height > 0) {
          return box.rect.y + box.rect.height;
        }
      }
    } catch {
      // Fallback below
    }
    return Math.max(0, rows - 5);
  }

  private findBoxForComponent(box: any, target: any): any {
    if (!box) return undefined;
    if (box.component === target || box.scrollView === target) return box;
    if (Array.isArray(box.children)) {
      for (const child of box.children) {
        const found = this.findBoxForComponent(child, target);
        if (found) return found;
      }
    }
    return undefined;
  }

  install(): () => void {
    if (this.active) return () => this.uninstall();
    const tuiAny = this.tui as any;
    if (typeof tuiAny.handleSelectionMouseEvent !== "function") {
      return () => {};
    }

    this.originalHandleSelectionMouseEvent = tuiAny.handleSelectionMouseEvent.bind(this.tui);
    this.originalApplySelection = typeof tuiAny.applySelection === "function" ? tuiAny.applySelection.bind(this.tui) : undefined;
    this.originalGetActiveSelectionText = typeof tuiAny.getActiveSelectionText === "function" ? tuiAny.getActiveSelectionText.bind(this.tui) : undefined;
    this.active = true;

    // 1. Intercept mouse events and clamp drag/release coordinates
    tuiAny.handleSelectionMouseEvent = (raw: RawMouseEvent) => {
      if (!this.active || !this.originalHandleSelectionMouseEvent) return;
      const isRelease = Boolean(raw.release);
      const isDrag = (raw.button & 32) !== 0;
      const isPress = !isRelease && !isDrag && (raw.button & 3) === 0;

      if (isPress) {
        this.activeRegion = this.resolveRegion(raw.x, raw.y);
      }

      let eventToDispatch = raw;
      if (this.activeRegion) {
        eventToDispatch = {
          ...raw,
          x: Math.max(this.activeRegion.minX, Math.min(this.activeRegion.maxX, raw.x)),
          y: Math.max(this.activeRegion.minY, Math.min(this.activeRegion.maxY, raw.y)),
        };
      }

      this.originalHandleSelectionMouseEvent(eventToDispatch);

      if (isRelease) {
        const hasSelection = typeof tuiAny.hasActiveSelection === "function"
          ? tuiAny.hasActiveSelection()
          : Boolean(Reflect.get(this.tui, "selectionAnchor"));
        if (!hasSelection) {
          this.activeRegion = undefined;
        }
      }
    };

    // 2. Intercept visual selection rendering to prevent highlight bleed across regions
    if (this.originalApplySelection) {
      tuiAny.applySelection = (screen: string[], layout?: any): string[] => {
        if (!this.active || !this.originalApplySelection) return screen;
        const rendered = this.originalApplySelection(screen, layout);
        if (!this.activeRegion) return rendered;

        const region = this.activeRegion;
        const cols = this.tui.terminal.columns;

        // If selection is in the sidebar, remove inverse highlights outside the sidebar
        if (region.type === "sidebar") {
          return rendered.map((line, rowIndex) => {
            const originalLine = screen[rowIndex] ?? "";
            if (!line.includes("\x1b[7m") || rowIndex < region.minY || rowIndex > region.maxY) {
              return originalLine;
            }
            const leftPart = sliceByColumn(originalLine, 0, region.minX, true);
            const rightPart = sliceByColumn(line, region.minX, cols - region.minX, true);
            return leftPart + rightPart;
          });
        }

        // If selection is in prompt box, remove inverse highlights outside the prompt box
        if (region.type === "prompt") {
          return rendered.map((line, rowIndex) => {
            const originalLine = screen[rowIndex] ?? "";
            if (rowIndex < region.minY || rowIndex > region.maxY) {
              return originalLine;
            }
            if (!line.includes("\x1b[7m")) return line;
            const promptPart = sliceByColumn(line, 0, region.maxX + 1, true);
            const sidePart = sliceByColumn(originalLine, region.maxX + 1, cols - (region.maxX + 1), true);
            return promptPart + sidePart;
          });
        }

        // If selection is in conversation, remove inverse highlights in prompt or sidebar
        if (region.type === "conversation") {
          return rendered.map((line, rowIndex) => {
            const originalLine = screen[rowIndex] ?? "";
            if (rowIndex > region.maxY) {
              return originalLine;
            }
            if (!line.includes("\x1b[7m")) return line;
            const convoPart = sliceByColumn(line, 0, region.maxX + 1, true);
            const sidePart = sliceByColumn(originalLine, region.maxX + 1, cols - (region.maxX + 1), true);
            return convoPart + sidePart;
          });
        }

        return rendered;
      };
    }

    // 3. Intercept active selection text copying to isolate copied text
    if (this.originalGetActiveSelectionText) {
      tuiAny.getActiveSelectionText = (): string | undefined => {
        if (!this.active || !this.originalGetActiveSelectionText) return undefined;
        const rawText = this.originalGetActiveSelectionText();
        if (!rawText || !this.activeRegion) return rawText;

        const region = this.activeRegion;
        const lines = rawText.split("\n");

        if (region.type === "sidebar") {
          // Keep only content within sidebar bounds
          return lines.map(line => sliceByColumn(line, region.minX, region.maxX - region.minX + 1, true).trimEnd()).join("\n");
        }

        if (region.type === "prompt" || region.type === "conversation") {
          // Keep only content within main pane bounds
          return lines.map(line => sliceByColumn(line, 0, region.maxX + 1, true).trimEnd()).join("\n");
        }

        return rawText;
      };
    }

    return () => this.uninstall();
  }

  uninstall(): void {
    if (!this.active) return;
    this.active = false;
    const tuiAny = this.tui as any;
    if (this.originalHandleSelectionMouseEvent) {
      tuiAny.handleSelectionMouseEvent = this.originalHandleSelectionMouseEvent;
      this.originalHandleSelectionMouseEvent = undefined;
    }
    if (this.originalApplySelection) {
      tuiAny.applySelection = this.originalApplySelection;
      this.originalApplySelection = undefined;
    }
    if (this.originalGetActiveSelectionText) {
      tuiAny.getActiveSelectionText = this.originalGetActiveSelectionText;
      this.originalGetActiveSelectionText = undefined;
    }
    this.activeRegion = undefined;
  }
}
