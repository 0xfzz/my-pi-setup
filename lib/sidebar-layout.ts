import { VERSION } from "@earendil-works/pi-coding-agent";
import { Container, HStack, isViewportTUI, sliceByColumn, truncateToWidth, visibleWidth, type Component, type ScrollView, type TUI } from "@earendil-works/pi-tui";
import { OnDemandContainer } from "./sidebar-ondemand.ts";
import { SelectionBoundaryController } from "./sidebar-selection.ts";

/**
 * Oldest Pi release whose fullscreen layout API this adapter targets.
 *
 * The adapter reaches a private `layoutRoot`/`setLayoutRoot` pair, so it cannot
 * rely on types and instead verifies the capability itself in `ensure()`. This
 * value is a *floor*, not a pin: an equality check against "1.3.0" disabled the
 * sidebar outright on 1.4.0, where `h-stack.js` is byte-identical to 1.3.0 and
 * every capability the adapter uses is present. Newer releases are accepted and
 * still capability-checked, so an incompatible layout degrades to the built-in
 * widgets (the warning path) instead of being refused by version number alone.
 */
export const MIN_PI_VERSION = "1.3.0";

/** Parse a leading `major.minor.patch`, ignoring any prerelease/build suffix. */
export function parseVersion(value: string): [number, number, number] | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value.trim());
  if (!match) return undefined;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * Whether `version` is at or above `floor`, compared numerically.
 *
 * String comparison would order "1.10.0" below "1.3.0"; an unparsable version
 * (including the "0.0.0" fallback Pi uses when it cannot read its own version)
 * is treated as unsupported rather than assumed compatible.
 */
export function atLeastVersion(version: string, floor: string): boolean {
  const actual = parseVersion(version);
  const minimum = parseVersion(floor);
  if (!actual || !minimum) return false;
  for (let index = 0; index < 3; index++) {
    if (actual[index] !== minimum[index]) return actual[index]! > minimum[index]!;
  }
  return true;
}

export const SIDEBAR_WIDTH = 24;
export const SIDEBAR_MIN_COLUMNS = 100;
export const SIDEBAR_MIN_WIDTH = 20;
export const SIDEBAR_MAX_WIDTH = 60;
export const CHAT_MIN_WIDTH = 76;

export function sidebarWidth(columns: number, requested: number): number {
  return Math.max(0, Math.min(requested, columns - CHAT_MIN_WIDTH));
}

/** Keep native layout metadata/mouse routing while changing only the side basis. */
class SidebarStack extends HStack {
  setWidth(width: number): void { this.entries[1]!.basis = width; }
  setExpanded(expanded: boolean): void { this.entries[0]!.minSize = expanded ? CHAT_MIN_WIDTH : 1; }
}

/** Regular mode keeps terminal scrollback. Attach the sidebar only to the last
 * visible screenful, without adding rows to a long transcript. */
export class SidebarSplit implements Component {
  readonly children: Component[];
  readonly main: Container;
  readonly side: Component;
  readonly tui: Pick<TUI, "terminal">;
  readonly enabled: () => boolean;
  readonly width: () => number;
  constructor(main: Container, side: Component, tui: Pick<TUI, "terminal">, enabled: () => boolean, width = () => SIDEBAR_WIDTH) {
    this.main = main; this.side = side; this.tui = tui; this.enabled = enabled; this.width = width;
    this.children = [main, side];
  }

  render(width: number): string[] {
    if (!this.enabled() || width < SIDEBAR_MIN_COLUMNS) return this.main.render(width);
    const sideWidth = sidebarWidth(width, this.width());
    const mainWidth = width - sideWidth;
    const left = this.main.render(mainWidth);
    const rows = Math.max(1, this.tui.terminal.rows);
    const right = this.side.render(sideWidth).slice(0, rows);
    while (left.length < right.length) left.push("");
    const start = Math.max(0, left.length - rows);
    return left.map((line, index) => {
      const side = right[index - start];
      if (side === undefined) return line;
      // Preserve zero-width cursor markers and ANSI sequences in the editor.
      return line + " ".repeat(Math.max(0, mainWidth - visibleWidth(line))) + side;
    });
  }
  invalidate(): void { this.main.invalidate(); this.side.invalidate(); }
}

/** Pi 1.3.0+ adapter. Regular mode uses public component children. Fullscreen
 * exposes setLayoutRoot but no getter; feature-check the existing layoutRoot
 * field and wrap it without rebuilding its ScrollView or replacing the editor.
 * No Pi files, render methods, focus targets, or terminal streams are patched. */
export class SidebarMount {
  private split?: SidebarSplit;
  private fullscreen?: { original: Component; wrapper: SidebarStack };
  private onDemandDispose?: () => void;
  private selectionController?: SelectionBoundaryController;
  private selectionDispose?: () => void;
  readonly tui: TUI;
  readonly side: Component;
  readonly enabled: () => boolean;
  readonly width: () => number;
  constructor(tui: TUI, side: Component, enabled: () => boolean, width = () => SIDEBAR_WIDTH) {
    this.tui = tui; this.side = side; this.enabled = enabled; this.width = width;
  }

  private setupOnDemand(root: Component): void {
    if (this.onDemandDispose) return;
    try {
      const entries = Reflect.get(root, "entries") as Array<{ component: Component }> | undefined;
      const transcript = entries?.[0]?.component as ScrollView | undefined;
      const doc = (transcript ? Reflect.get(transcript, "child") : undefined) as Container | undefined;
      const chat = doc?.children?.[2] as Container | undefined;
      if (chat && typeof chat.render === "function") {
        const onDemand = new OnDemandContainer(chat, () => transcript, { threshold: 12, bufferLines: 25 });
        this.onDemandDispose = onDemand.install();
      }
    } catch {
      // Graceful fallback if layout structure differs
    }
  }

  updateWidth(width: number): void {
    if (this.fullscreen?.wrapper) {
      this.fullscreen.wrapper.setWidth(width);
    }
  }

  ensure(): boolean {
    if (this.tui.mode === "fullscreen") {
      // Capability first, then a minimum-release floor. The capability checks are
      // what actually decide compatibility; the floor only excludes releases that
      // predate this private API.
      if (!atLeastVersion(VERSION, MIN_PI_VERSION) || !isViewportTUI(this.tui)) return false;
      const root = Reflect.get(this.tui, "layoutRoot") as Component | undefined;
      const setRoot = Reflect.get(this.tui, "setLayoutRoot");
      if (!root || typeof root.render !== "function" || typeof root.invalidate !== "function" || typeof setRoot !== "function") return false;
      if (root === this.fullscreen?.wrapper) {
        this.fullscreen.wrapper.setWidth(this.width());
        return true;
      }
      try {
        this.setupOnDemand(root);
        if (!this.selectionController && isViewportTUI(this.tui)) {
          this.selectionController = new SelectionBoundaryController(this.tui, {
            enabled: this.enabled,
            width: this.width,
          });
          this.selectionDispose = this.selectionController.install();
        }
        const wrapper: SidebarStack = new SidebarStack([
          { component: root, basis: 0, grow: 1, shrink: 1, minSize: 1 },
          { component: this.side, basis: this.width(), grow: 0, shrink: 1, minSize: SIDEBAR_MIN_WIDTH, maxSize: SIDEBAR_MAX_WIDTH,
            visible: viewport => {
              const expanded = this.enabled() && viewport.width >= SIDEBAR_MIN_COLUMNS;
              wrapper.setExpanded(expanded);
              return expanded;
            } },
        ]);
        setRoot.call(this.tui, wrapper);
        // Recorded only after the root was accepted, so a throw below leaves the
        // mount not-yet-attached rather than half-attached.
        this.fullscreen = { original: root, wrapper };
        return true;
      } catch {
        // A newer or otherwise unexpected layout must degrade to the built-in
        // widgets instead of breaking the renderer, which is what the caller's
        // "existing widgets remain enabled" warning promises.
        return false;
      }
    }
    if (this.split && this.tui.children.includes(this.split)) return true;
    if (!this.tui.children.length) return false;
    const main = new Container();
    main.children.push(...this.tui.children);
    this.split = new SidebarSplit(main, this.side, this.tui, this.enabled, this.width);
    this.tui.children.splice(0, this.tui.children.length, this.split);
    this.tui.requestRender();
    return true;
  }

  dispose(): void {
    if (this.selectionDispose) {
      this.selectionDispose();
      this.selectionDispose = undefined;
      this.selectionController = undefined;
    }
    if (this.onDemandDispose) {
      this.onDemandDispose();
      this.onDemandDispose = undefined;
    }
    if (this.fullscreen && Reflect.get(this.tui, "layoutRoot") === this.fullscreen.wrapper) {
      const setRoot = Reflect.get(this.tui, "setLayoutRoot");
      if (typeof setRoot === "function") setRoot.call(this.tui, this.fullscreen.original);
    }
    if (this.split) {
      const index = this.tui.children.indexOf(this.split);
      if (index >= 0) this.tui.children.splice(index, 1, ...this.split.main.children);
    }
    this.tui.requestRender();
  }
}

/** Data labels are plain text, never executable terminal control sequences. */
export function plain(text: string): string {
  return text.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\x00-\x1f\x7f-\x9f]/g, " ").replace(/\s+/g, " ").trim();
}

export function fit(text: string, width: number): string {
  return truncateToWidth(plain(text), Math.max(0, width));
}

/** Wrap todo rows to available width with readable continuation indentation.
 * Preserves task status prefix and indents continuation lines. */
export function wrapTodoRow(row: string, width: number, maxLines = 4): string[] {
  const contentWidth = Math.max(0, width);
  if (contentWidth === 0) return [];
  const cleaned = plain(row);
  if (!cleaned) return [];

  if (visibleWidth(cleaned) <= contentWidth) {
    return [cleaned];
  }

  const match = cleaned.match(/^(\[\d+\]\s+\S+\s+|[☑☐✓✔●○⊘◷⊝☒◐▣]\s+)(.*)$/);
  const prefix = match ? match[1]! : "";
  const content = match ? match[2]! : cleaned;
  const prefixW = visibleWidth(prefix);

  if (prefixW >= contentWidth) {
    return [truncateToWidth(cleaned, contentWidth)];
  }

  // If prefix is short (e.g. "☑ " is 2 cols), continuation indents by exact prefix width
  // If prefix is longer (e.g. "[1] ● " is 6 cols), indent by 4 cols if narrow (< 28), else prefixW
  const indentW = prefixW <= 4 ? (prefixW || 2)
    : (contentWidth >= 28 && prefixW <= 8 ? prefixW : Math.min(4, Math.max(2, prefixW)));
  const indent = " ".repeat(indentW);

  const words = content.trim().split(/\s+/);
  const lines: string[] = [];
  let cur = prefix;
  let curW = prefixW;

  for (let i = 0; i < words.length; i++) {
    let word = words[i]!;
    if (!word) continue;

    const lineIndentW = lines.length === 0 ? prefixW : indentW;
    const maxAvailable = contentWidth - lineIndentW;

    while (visibleWidth(word) > maxAvailable && maxAvailable > 0) {
      if (curW > lineIndentW) {
        lines.push(cur);
        cur = indent;
        curW = indentW;
        if (lines.length >= maxLines) break;
      }
      const part = sliceByColumn(word, 0, maxAvailable);
      word = word.slice(part.length);
      cur += part;
      lines.push(cur);
      cur = indent;
      curW = indentW;
      if (lines.length >= maxLines) break;
    }
    if (lines.length >= maxLines) break;

    const spaceW = curW === (lines.length === 0 ? prefixW : indentW) ? 0 : 1;
    const wordW = visibleWidth(word);

    if (curW + spaceW + wordW <= contentWidth) {
      cur += (spaceW ? " " : "") + word;
      curW += spaceW + wordW;
    } else {
      if (lines.length + 1 >= maxLines) {
        const withEllipsis = cur + " …";
        lines.push(truncateToWidth(withEllipsis, contentWidth));
        cur = "";
        break;
      }
      lines.push(cur);
      cur = indent + word;
      curW = indentW + wordW;
    }
  }

  if (cur.trim() && lines.length < maxLines) {
    lines.push(cur);
  }

  return lines.map(l => truncateToWidth(l, contentWidth));
}
