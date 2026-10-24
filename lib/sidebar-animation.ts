/* Pluggable ASCII Animation System for Pi Sidebar.
 * Supports multiple built-in and user-registered ASCII animations
 * (Aquarium, Matrix Rain, Campfire, or custom extensions).
 */
import { visibleWidth, sliceByColumn } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createAquarium, feedAquarium, type AquariumTheme, type ThemeToken } from "./sidebar-aquarium.ts";
import { renderWasmScene } from "./ascii-anim-engine.ts";
import { catsPiece } from "./sidebar-cats.ts";

export { catsPiece } from "./sidebar-cats.ts";

export interface AsciiAnimationPiece {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
  readonly fps?: number;
  readonly minHeight?: number;
  readonly maxHeight?: number;
  render(cols: number, rows: number, seconds: number, theme?: AquariumTheme): string[];
  feed?(col?: number): boolean;
  dropFood?(col?: number): any;
  handleMouse?(event: any, bounds: { x: number; y: number; width: number; height: number }): any;
  dispose?(): void;
}

export const ANIMATION_MIN_HEIGHT = 6;
export const ANIMATION_MAX_HEIGHT = 10;
export const ANIMATION_REGISTER_EVENT = "sidebar:register_animation";

export function animationHeight(rows: number, sectionRows: number, maxHeight = ANIMATION_MAX_HEIGHT): number {
  const height = Math.min(maxHeight, rows - sectionRows - 2);
  return height >= ANIMATION_MIN_HEIGHT ? height : 0;
}

// ---------------------------------------------------------------------------
// 1. Built-in: Aquarium (Rust WASM + TS fallback)
// ---------------------------------------------------------------------------
export const aquariumPiece: AsciiAnimationPiece = {
  id: "aquarium",
  name: "Aquarium",
  description: "Tropical fish, swimming neon tetras, swaying kelp, and rising bubbles",
  fps: 15,
  minHeight: 6,
  maxHeight: 10,
  render(cols, rows, seconds, theme) {
    return createAquarium(cols, rows)(seconds, theme);
  },
  feed(col?: number) {
    return feedAquarium(col);
  },
  dropFood(col?: number) {
    return feedAquarium(col);
  },
  handleMouse(event, bounds) {
    const tankX = event.x - bounds.x;
    const tankY = event.y - bounds.y;
    if (tankY <= 2 && tankX >= 1 && tankX <= bounds.width - 2) {
      feedAquarium(tankX);
      return { handled: true, render: true };
    }
  },
};

// ---------------------------------------------------------------------------
// 2. Built-in: Matrix Rain (Digital rain stream)
// ---------------------------------------------------------------------------
const MATRIX_CHARS = "0123456789ABCDEFｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ";

function hash(a: number, b: number): number {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export const matrixPiece: AsciiAnimationPiece = {
  id: "matrix",
  name: "Matrix Rain",
  description: "Cascading digital code streams in phosphorescent green",
  fps: 12,
  minHeight: 6,
  maxHeight: 10,
  render(cols, rows, seconds, theme) {
    if (!theme) {
      const wasm = renderWasmScene("matrix", cols, rows, seconds, false);
      if (wasm) return wasm;
    }

    const fg = theme?.fg ? theme.fg.bind(theme) : (_token: ThemeToken, text: string) => text;
    const innerW = cols - 2;
    const innerH = rows - 2;

    const grid: { char: string; color: ThemeToken }[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: " ", color: "text" }))
    );

    // Box border in dim green
    grid[0] = [
      { char: "┌", color: "dim" },
      ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┐", color: "dim" },
    ];
    grid[rows - 1] = [
      { char: "└", color: "dim" },
      ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┘", color: "dim" },
    ];
    for (let r = 1; r < rows - 1; r++) {
      grid[r]![0] = { char: "│", color: "dim" };
      grid[r]![cols - 1] = { char: "│", color: "dim" };
    }

    // Rain drops per column
    for (let c = 1; c <= innerW; c++) {
      const speed = 2.0 + (hash(c, 1) * 3.5);
      const length = 3 + Math.floor(hash(c, 2) * 5);
      const offset = hash(c, 3) * 20.0;
      const headPos = ((seconds * speed + offset) % (innerH + length + 4)) - length;

      for (let k = 0; k < length; k++) {
        const dropRow = Math.floor(headPos + k);
        if (dropRow >= 0 && dropRow < innerH) {
          const charIdx = Math.floor((seconds * 10 + c * 7 + k * 13) % MATRIX_CHARS.length);
          const ch = MATRIX_CHARS[charIdx]!;
          const targetR = 1 + dropRow;
          if (k === length - 1) {
            // Bright white leading head
            grid[targetR]![c] = { char: ch, color: "text" };
          } else if (k >= length - 3) {
            // Bright green body
            grid[targetR]![c] = { char: ch, color: "success" };
          } else {
            // Dim green fading tail
            grid[targetR]![c] = { char: ch, color: "dim" };
          }
        }
      }
    }

    return grid.map(row => {
      let line = "";
      let curToken: ThemeToken | undefined;
      let span = "";
      for (const cell of row) {
        if (cell.color === curToken) {
          span += cell.char;
        } else {
          if (span) line += curToken ? fg(curToken, span) : span;
          curToken = cell.color;
          span = cell.char;
        }
      }
      if (span) line += curToken ? fg(curToken, span) : span;
      return line;
    });
  },
};

// ---------------------------------------------------------------------------
// 3. Built-in: Campfire (Flickering hearth flames)
// ---------------------------------------------------------------------------
const FLAME_CHARS = [" ", ".", ",", "^", "~", "*", "(", ")", "#"];

export const campfirePiece: AsciiAnimationPiece = {
  id: "fire",
  name: "Campfire",
  description: "Cozy flickering hearth with rising embers",
  fps: 12,
  minHeight: 6,
  maxHeight: 10,
  render(cols, rows, seconds, theme) {
    if (!theme) {
      const wasm = renderWasmScene("fire", cols, rows, seconds, false);
      if (wasm) return wasm;
    }

    const fg = theme?.fg ? theme.fg.bind(theme) : (_token: ThemeToken, text: string) => text;
    const innerW = cols - 2;
    const innerH = rows - 2;
    const floor = rows - 2;

    const grid: { char: string; color: ThemeToken }[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: " ", color: "text" }))
    );

    // Box border in dim amber
    grid[0] = [
      { char: "┌", color: "dim" },
      ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┐", color: "dim" },
    ];
    grid[rows - 1] = [
      { char: "└", color: "dim" },
      ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┘", color: "dim" },
    ];
    for (let r = 1; r < rows - 1; r++) {
      grid[r]![0] = { char: "│", color: "dim" };
      grid[r]![cols - 1] = { char: "│", color: "dim" };
    }

    // Wood logs at floor
    const centerCol = Math.floor(cols / 2);
    const logWidth = Math.min(innerW - 2, 14);
    const logStart = Math.max(1, centerCol - Math.floor(logWidth / 2));
    for (let i = 0; i < logWidth; i++) {
      const c = logStart + i;
      if (c > 0 && c < cols - 1) {
        grid[floor]![c] = { char: i % 2 === 0 ? "=" : "#", color: "dim" };
      }
    }

    // Flames rising from log
    const flameHeight = Math.max(2, innerH - 2);
    for (let r = 1; r <= flameHeight; r++) {
      const rowIdx = floor - r;
      if (rowIdx <= 0) break;
      const taper = Math.floor((r / flameHeight) * (logWidth / 2));
      const fStart = logStart + taper;
      const fEnd = logStart + logWidth - taper;

      for (let c = fStart; c < fEnd; c++) {
        if (c <= 0 || c >= cols - 1) continue;
        const noise = Math.sin(c * 1.7 + seconds * 9.0 + r * 2.3) + Math.cos(c * 3.1 - seconds * 7.0);
        if (noise > -0.2) {
          const charIdx = Math.min(FLAME_CHARS.length - 1, Math.floor(Math.abs(noise) * 3.5) + (flameHeight - r));
          const ch = FLAME_CHARS[charIdx] || "^";
          const color: ThemeToken = r <= 2 ? "warning" : r <= 4 ? "error" : "dim";
          grid[rowIdx]![c] = { char: ch, color };
        }
      }
    }

    // Rising embers
    for (let k = 0; k < 5; k++) {
      const age = (seconds * 2.5 + k * 1.3) % 4.0;
      const emberRow = floor - 2 - Math.floor(age * 1.5);
      const wobble = Math.sin(age * 4.0 + k) * 1.5;
      const emberCol = Math.round(centerCol + wobble + (k - 2) * 2);
      if (emberRow > 0 && emberRow < floor && emberCol > 0 && emberCol < cols - 1) {
        grid[emberRow]![emberCol] = { char: age > 2.5 ? "·" : ".", color: "warning" };
      }
    }

    return grid.map(row => {
      let line = "";
      let curToken: ThemeToken | undefined;
      let span = "";
      for (const cell of row) {
        if (cell.color === curToken) {
          span += cell.char;
        } else {
          if (span) line += curToken ? fg(curToken, span) : span;
          curToken = cell.color;
          span = cell.char;
        }
      }
      if (span) line += curToken ? fg(curToken, span) : span;
      return line;
    });
  },
};

// ---------------------------------------------------------------------------
// 4. Built-in: Autonomous Random Gallery (Smooth transitions between all arts)
// ---------------------------------------------------------------------------
export function blendFrames(
  fA: string[],
  fB: string[],
  easeP: number,
  cols: number,
  rows: number,
  theme?: AquariumTheme
): string[] {
  const fg = theme?.fg ? theme.fg.bind(theme) : (_tok: ThemeToken, txt: string) => txt;
  const result: string[] = [];
  result.push(fA[0] ?? "");
  const borderV = theme ? fg("dim", "│") : "│";

  for (let r = 1; r < rows - 1; r++) {
    let rowStr = borderV;
    const rowA = fA[r] ?? "";
    const rowB = fB[r] ?? "";
    for (let c = 1; c < cols - 1; c++) {
      const colP = (c - 1) / Math.max(1, cols - 3);
      if (colP <= easeP) {
        rowStr += sliceByColumn(rowB, c, 1);
      } else {
        rowStr += sliceByColumn(rowA, c, 1);
      }
    }
    rowStr += borderV;
    result.push(rowStr);
  }
  result.push(fA[rows - 1] ?? "");
  return result;
}

export const randomPiece: AsciiAnimationPiece = {
  id: "auto",
  name: "Auto Gallery",
  description: "Slow-paced autonomous rotation across all ASCII art scenes with smooth transitions",
  fps: 10,
  minHeight: 6,
  maxHeight: 10,
  render(cols, rows, seconds, theme) {
    const POOL = [catsPiece, aquariumPiece, campfirePiece, matrixPiece];
    const DURATION = 28.0;
    const TRANSITION = 1.6;

    const ep = Math.floor(seconds / DURATION);
    const localSec = seconds % DURATION;

    const curIdx = Math.floor(hash(ep, 77) * POOL.length) % POOL.length;
    const curPiece = POOL[curIdx]!;
    const nextCandidates = POOL.filter((_, idx) => idx !== curIdx);
    const nextIdx = Math.floor(hash(ep + 1, 77) * nextCandidates.length) % nextCandidates.length;
    const nextPiece = nextCandidates[nextIdx]!;

    const timeLeft = DURATION - localSec;
    if (timeLeft < TRANSITION) {
      const p = 1.0 - timeLeft / TRANSITION;
      const easeP = p * p * (3 - 2 * p);
      const fA = curPiece.render(cols, rows, localSec, theme);
      const fB = nextPiece.render(cols, rows, 0, theme);
      return blendFrames(fA, fB, easeP, cols, rows, theme);
    }
    return curPiece.render(cols, rows, localSec, theme);
  },
};

// ---------------------------------------------------------------------------
// Animation Registry & Persistence
// ---------------------------------------------------------------------------
export interface AnimationRegistryOptions {
  initialId?: string;
  persistencePath?: string;
  autoRestore?: boolean;
}

function getDefaultPersistencePath(): string | undefined {
  try {
    const home = typeof os !== "undefined" && typeof os.homedir === "function" ? os.homedir() : undefined;
    if (home) {
      return path.join(home, ".pi", "sidebar-anim.json");
    }
  } catch {}
  return undefined;
}

export class AnimationRegistry {
  private pieces = new Map<string, AsciiAnimationPiece>();
  private activeId = "aquarium";
  private persistencePath?: string;

  constructor(options?: AnimationRegistryOptions) {
    this.register(aquariumPiece);
    this.register(matrixPiece);
    this.register(campfirePiece);
    this.register(catsPiece);
    this.register(randomPiece);

    this.persistencePath = options?.persistencePath ?? getDefaultPersistencePath();

    if (options?.initialId) {
      this.select(options.initialId, false);
    } else if (options?.autoRestore) {
      this.restorePersisted();
    }
  }

  get persistenceFile(): string | undefined {
    return this.persistencePath;
  }

  normalizeId(id: string): string {
    let lower = id.toLowerCase();
    if (lower === "cat") lower = "cats";
    if (lower === "campfire") lower = "fire";
    if (lower === "random" || lower === "shuffle" || lower === "gallery") lower = "auto";
    return lower;
  }

  register(piece: AsciiAnimationPiece): void {
    this.pieces.set(piece.id.toLowerCase(), piece);
  }

  unregister(id: string): boolean {
    const lower = id.toLowerCase();
    if (lower === this.activeId) this.activeId = "aquarium";
    return this.pieces.delete(lower);
  }

  get(id: string): AsciiAnimationPiece | undefined {
    return this.pieces.get(this.normalizeId(id));
  }

  list(): AsciiAnimationPiece[] {
    return Array.from(this.pieces.values());
  }

  get current(): AsciiAnimationPiece {
    return this.pieces.get(this.activeId) ?? aquariumPiece;
  }

  get currentId(): string {
    return this.activeId;
  }

  restorePersisted(): boolean {
    const saved = this.loadPersisted();
    if (saved && this.pieces.has(saved)) {
      this.activeId = saved;
      return true;
    }
    return false;
  }

  loadPersisted(): string | undefined {
    if (typeof localStorage !== "undefined") {
      try {
        const item = localStorage.getItem("pi_sidebar_anim_default");
        if (item) return this.normalizeId(item);
      } catch {}
    }
    if (this.persistencePath) {
      try {
        if (existsSync(this.persistencePath)) {
          const raw = readFileSync(this.persistencePath, "utf8");
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed.lastPicked === "string") {
            return this.normalizeId(parsed.lastPicked);
          }
        }
      } catch {}
    }
    return undefined;
  }

  persist(id: string): void {
    const norm = this.normalizeId(id);
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem("pi_sidebar_anim_default", norm);
      } catch {}
    }
    if (this.persistencePath) {
      try {
        const dir = path.dirname(this.persistencePath);
        if (!existsSync(dir)) {
          mkdirSync(dir, { recursive: true });
        }
        writeFileSync(
          this.persistencePath,
          JSON.stringify({ lastPicked: norm, updatedAt: new Date().toISOString() }, null, 2),
          "utf8"
        );
      } catch {}
    }
  }

  select(id: string, persistChoice = true): boolean {
    const lower = this.normalizeId(id);
    if (this.pieces.has(lower)) {
      this.activeId = lower;
      if (persistChoice) {
        this.persist(lower);
      }
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Lifecycle-Managed Animation Player
// ---------------------------------------------------------------------------
export class SidebarAnimationPlayer {
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private paused = false;
  private frame = 0;
  private currentId = "";
  readonly registry: AnimationRegistry;
  private readonly visible: () => boolean;
  private readonly redraw: () => void;

  constructor(registry: AnimationRegistry, visible: () => boolean, redraw: () => void) {
    this.registry = registry;
    this.visible = visible;
    this.redraw = redraw;
  }

  pause(): void {
    this.paused = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  resume(): void {
    this.paused = false;
    this.sync();
  }

  sync(): void {
    if (this.disposed || this.paused || !this.visible()) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    } else {
      const piece = this.registry.current;
      const targetFps = piece.fps ?? 15;
      if (!this.timer || this.currentId !== piece.id) {
        if (this.timer) clearInterval(this.timer);
        this.currentId = piece.id;
        this.timer = setInterval(() => {
          if (this.disposed || this.paused || !this.visible()) {
            this.sync();
            return;
          }
          this.frame++;
          this.redraw();
        }, 1000 / targetFps);
        this.timer.unref?.();
      }
    }
  }

  render(width: number, height: number, theme?: AquariumTheme): string[] {
    const piece = this.registry.current;
    const fps = piece.fps ?? 15;
    return piece.render(width, height, this.frame / fps, theme);
  }

  handleMouse(
    event: any,
    bounds: { x: number; y: number; width: number; height: number }
  ): { handled: boolean; render: boolean } | undefined {
    const piece = this.registry.current;
    if (typeof piece.handleMouse === "function") {
      return piece.handleMouse(event, bounds);
    }
  }

  feed(col?: number): boolean {
    const piece = this.registry.current;
    if (typeof piece.feed === "function") {
      return piece.feed(col);
    }
    return false;
  }

  dispose(): void {
    this.disposed = true;
    this.sync();
    for (const piece of this.registry.list()) {
      piece.dispose?.();
    }
  }
}
