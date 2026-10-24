/* Refined ASCII Aquarium for Pi Sidebar.
 * Features classic terminal sea life (tropical angelfish, neon tetra, minnow,
 * pulsating jellyfish, scuttling crab), swaying kelp, gravel bed, and gentle bubbles.
 * High-performance dual engine:
 * 1. Rust WebAssembly engine (crates/aquarium-engine) for microsecond zero-allocation
 *    rendering during high-frequency drag-resizing and animation.
 * 2. Pure TypeScript fallback engine for environments without WASM or custom theme mocks.
 * 
 * Enhanced Biota Behaviors:
 * - Autonomous organic 2D random wandering (depth and horizontal movements, natural turns/pauses).
 * - Hunger awareness: biota get hungry over time; eye and face expressions reflect hunger.
 * - Interactive feeding: clicking the top position of the fish tank drops food pellets/flakes.
 * - Gravity physics: food drops from the top and accelerates downwards with water resistance.
 * - Food awareness & pursuit: hungry biota notice food, steer toward it, and eat it.
 * - Crab gravel foraging: food that settles on the gravel bed is sought out and eaten by the crab.
 * - Satiated/happy expressions when fed!
 *
 * Inspired by classic asciiquarium (Kirk Baucom / Joan Stark) & ascii.rest/aquarium.
 * Copyright (c) 2026 bas3line. MIT; see licenses/ascii-rest-MIT.txt.
 */
import { getAsciiAnimEngine, renderWasmScene } from "./ascii-anim-engine.ts";

export const AQUARIUM_FPS = 15;
export const AQUARIUM_MIN_HEIGHT = 6;
export const AQUARIUM_MAX_HEIGHT = 10;
const LOOP = 48; // seconds for complete cycle

export type ThemeToken = "accent" | "muted" | "dim" | "warning" | "success" | "error" | "text";

export interface AquariumTheme {
  fg: (token: ThemeToken, text: string) => string;
}

interface Cell {
  char: string;
  color: ThemeToken;
}

const hash = (a: number, b: number): number => {
  let h = Math.imul(a, 0x27d4eb2d) ^ Math.imul(b, 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** Leave sections untouched; only use spare rows (blank + heading + tank). */
export function aquariumHeight(rows: number, sectionRows: number): number {
  const height = Math.min(AQUARIUM_MAX_HEIGHT, rows - sectionRows - 2);
  return height >= AQUARIUM_MIN_HEIGHT ? height : 0;
}

// ---------------------------------------------------------------------------
// Food and Hunger Interfaces & State Engine
// ---------------------------------------------------------------------------

export interface FoodParticle {
  id: number;
  x: number;          // Column in tank (2 .. cols - 3)
  y: number;          // Current row (float) starting at 1.0 (water surface)
  vy: number;         // Downward velocity (accelerates with gravity)
  settled: boolean;   // Settled on gravel floor
  settleTimer: number;// Ticks before dissolving on gravel bed
  eaten: boolean;     // Eaten by a fish or crab
}

export type BiotaMood = "satisfied" | "hungry" | "seeking" | "eating";

export interface BiotaStatus {
  name: string;
  hunger: number;     // 0.0 (full) to 1.0 (starving)
  mood: BiotaMood;
  x: number;
  y: number;
  facing: "right" | "left" | "turn";
}

/** Multi-harmonic wander generator with exact period LOOP = 48. */
function wander1D(u: number, seed: number): { pos: number; vel: number } {
  const w = (2 * Math.PI) / LOOP;
  const p1 = (seed * 1.61803) % (2 * Math.PI);
  const p2 = (seed * 2.71828) % (2 * Math.PI);
  const p3 = (seed * 3.14159) % (2 * Math.PI);
  const p4 = (seed * 4.66920) % (2 * Math.PI);

  const pos =
    0.5 +
    0.28 * Math.sin(1 * w * u + p1) +
    0.14 * Math.sin(2 * w * u + p2) +
    0.06 * Math.sin(3 * w * u + p3) +
    0.03 * Math.sin(5 * w * u + p4);

  const vel =
    0.28 * 1 * w * Math.cos(1 * w * u + p1) +
    0.14 * 2 * w * Math.cos(2 * w * u + p2) +
    0.06 * 3 * w * Math.cos(3 * w * u + p3) +
    0.03 * 5 * w * Math.cos(5 * w * u + p4);

  return { pos: Math.max(0, Math.min(1, pos)), vel };
}

function wanderDepth(u: number, seed: number): number {
  const w = (2 * Math.PI) / LOOP;
  const p1 = (seed * 1.73205) % (2 * Math.PI);
  const p2 = (seed * 3.41421) % (2 * Math.PI);
  const pos = 0.5 + 0.35 * Math.sin(2 * w * u + p1) + 0.15 * Math.sin(4 * w * u + p2);
  return Math.max(0, Math.min(1, pos));
}

export class AquariumSimulation {
  cols: number;
  rows: number;
  foods: FoodParticle[] = [];
  hungerLevels: Map<string, number> = new Map();
  eatingTimers: Map<string, number> = new Map();
  biotaPositions: Map<string, { x: number; y: number; facing: "right" | "left" | "turn" }> = new Map();
  lastSeconds?: number;
  private nextFoodId = 1;

  constructor(cols: number = 24, rows: number = 8) {
    this.cols = cols;
    this.rows = rows;
    this.hungerLevels.set("tetra", 0.55);
    this.hungerLevels.set("minnow", 0.40);
    this.hungerLevels.set("angelfish", 0.50);
    this.hungerLevels.set("crab", 0.35);
    this.hungerLevels.set("jellyfish", 0.20);
  }

  resize(cols: number, rows: number): void {
    this.cols = cols;
    this.rows = rows;
    const floor = rows - 2;
    for (const f of this.foods) {
      f.x = Math.max(2, Math.min(cols - 3, f.x));
      if (f.y >= floor) {
        f.y = floor;
        f.settled = true;
      }
    }
  }

  dropFood(col?: number): FoodParticle {
    const floor = this.rows - 2;
    const targetCol = col !== undefined
      ? Math.max(2, Math.min(this.cols - 3, Math.round(col)))
      : Math.floor(this.cols * 0.3 + Math.random() * (this.cols * 0.4));

    const food: FoodParticle = {
      id: this.nextFoodId++,
      x: targetCol,
      y: 1.0,          // Water surface
      vy: 0.14,        // Initial sinking velocity
      settled: false,
      settleTimer: 75, // 5 seconds at 15 FPS
      eaten: false,
    };
    this.foods.push(food);
    return food;
  }

  clearFoods(): void {
    this.foods = [];
  }

  hasActiveFoods(): boolean {
    return this.foods.some(f => !f.eaten);
  }

  getHunger(id: string): number {
    return this.hungerLevels.get(id) ?? 0.5;
  }

  setHunger(id: string, value: number): void {
    this.hungerLevels.set(id, Math.max(0, Math.min(1, value)));
  }

  update(seconds: number): void {
    const dt = this.lastSeconds !== undefined
      ? Math.max(0, Math.min(0.2, seconds - this.lastSeconds))
      : (1 / AQUARIUM_FPS);
    this.lastSeconds = seconds;
    const floor = this.rows - 2;

    // Advance hunger
    for (const [id, h] of this.hungerLevels) {
      const rate = id === "minnow" ? 0.05 : id === "tetra" ? 0.04 : 0.035;
      this.hungerLevels.set(id, Math.min(1.0, h + dt * rate));
    }

    // Decrement eating timers
    for (const [id, t] of this.eatingTimers) {
      if (t > 0) {
        this.eatingTimers.set(id, Math.max(0, t - dt));
      }
    }

    // Physics step for food particles under gravity
    for (const f of this.foods) {
      if (f.eaten) continue;
      if (!f.settled) {
        f.y += f.vy * (dt * AQUARIUM_FPS);
        // Gravity accelerates downward, terminal velocity capped by water drag
        f.vy = Math.min(0.32, f.vy + 0.012 * (dt * AQUARIUM_FPS));
        if (f.y >= floor) {
          f.y = floor;
          f.settled = true;
        }
      } else {
        f.settleTimer -= dt * AQUARIUM_FPS;
        if (f.settleTimer <= 0) {
          f.eaten = true;
        }
      }
    }

    this.foods = this.foods.filter(f => !f.eaten);
  }
}

let activeSimulation: AquariumSimulation | undefined;

export function getAquariumSimulation(cols: number = 24, rows: number = 8): AquariumSimulation {
  if (!activeSimulation || activeSimulation.cols !== cols || activeSimulation.rows !== rows) {
    activeSimulation = new AquariumSimulation(cols, rows);
  }
  return activeSimulation;
}

export function feedAquarium(col?: number): boolean {
  const sim = activeSimulation ?? getAquariumSimulation(24, 8);
  sim.dropFood(col);
  return true;
}

export function clearAquariumFood(): void {
  if (activeSimulation) {
    activeSimulation.clearFoods();
  }
}

// ---------------------------------------------------------------------------
// JavaScript ASCII Aquarium Renderer
// ---------------------------------------------------------------------------

function createJsAquarium(
  cols: number,
  rows: number,
  simulation?: AquariumSimulation
): (seconds: number, theme?: AquariumTheme) => string[] {
  const floor = rows - 2;
  const waterDepth = floor - 2;
  const sim = simulation;

  // Precompute gravel bed so it doesn't shift during swimming
  const gravel = Array.from({ length: cols - 2 }, (_, c) => {
    const n = hash(c, 7);
    if (n < 0.12) return { char: "o", color: "muted" as ThemeToken };
    if (n < 0.22) return { char: "°", color: "dim" as ThemeToken };
    if (n < 0.35) return { char: ".", color: "dim" as ThemeToken };
    if (n < 0.50) return { char: "·", color: "dim" as ThemeToken };
    if (n < 0.62) return { char: ",", color: "dim" as ThemeToken };
    return { char: " ", color: "dim" as ThemeToken };
  });

  return (seconds: number, theme?: AquariumTheme): string[] => {
    const u = ((seconds % LOOP) + LOOP) % LOOP;

    // Advance simulation if active
    if (sim) {
      sim.update(seconds);
    }

    const grid: Cell[][] = Array.from({ length: rows }, () =>
      Array.from({ length: cols }, () => ({ char: " ", color: "text" as ThemeToken }))
    );

    const put = (r: number, c: number, text: string, color: ThemeToken = "text") => {
      if (r <= 0 || r >= rows - 1) return;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i]!;
        if (ch === " ") continue;
        const targetCol = c + i;
        if (targetCol > 0 && targetCol < cols - 1) {
          grid[r]![targetCol] = { char: ch, color };
        }
      }
    };

    // 1. Tank Glass Borders
    grid[0] = [
      { char: "┌", color: "dim" },
      ...Array.from({ length: cols - 2 }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┐", color: "dim" },
    ];
    grid[rows - 1] = [
      { char: "└", color: "dim" },
      ...Array.from({ length: cols - 2 }, () => ({ char: "─", color: "dim" as ThemeToken })),
      { char: "┘", color: "dim" },
    ];
    for (let r = 1; r < rows - 1; r++) {
      grid[r]![0] = { char: "│", color: "dim" };
      grid[r]![cols - 1] = { char: "│", color: "dim" };
    }

    // 2. Gentle Water Surface Ripples (vibrant aquatic blue)
    for (let c = 1; c < cols - 1; c++) {
      const wave = Math.sin(c * 0.45 - u * 2.8) + 0.4 * Math.sin(c * 0.85 + u * 1.9);
      const glyph = wave > 0.35 ? "~" : wave < -0.35 ? "^" : "-";
      grid[1]![c] = { char: glyph, color: "accent" };
    }

    // 3. Sandy Gravel Bed
    for (let c = 1; c < cols - 1; c++) {
      grid[floor]![c] = gravel[c - 1]!;
    }

    // 4. Bubble Stone & Air Bubbles
    const stoneCol = cols - 5;
    if (stoneCol > 8) {
      put(floor, stoneCol, "._.", "dim");
      const bubbleCount = cols < 26 ? 3 : 4;
      const bubbleCycle = 5.0;
      for (let k = 0; k < bubbleCount; k++) {
        const bubbleAge = (u + k * (bubbleCycle / bubbleCount)) % bubbleCycle;
        const progress = bubbleAge / bubbleCycle;
        const bubbleRow = Math.round(floor - 1 - progress * (floor - 2.5));
        const wobble = Math.sin(bubbleAge * 3.8 + k) * 0.7;
        const bubbleC = Math.round(stoneCol + 1 + wobble);
        if (bubbleRow >= 2 && bubbleRow < floor && bubbleC > 0 && bubbleC < cols - 1) {
          const glyph = progress < 0.25 ? "·" : progress < 0.6 ? "." : progress < 0.88 ? "o" : "°";
          const color: ThemeToken = progress >= 0.88 ? "text" : "accent";
          put(bubbleRow, bubbleC, glyph, color);
        }
      }
    }

    // 5. Swaying Kelp / Seaweed
    const weedRoots = [
      { col: 2, height: Math.min(Math.max(3, waterDepth), 5), phase: 0 },
      { col: cols - 4, height: Math.min(Math.max(2, waterDepth - 1), 4), phase: 1.8 },
    ];
    if (cols >= 42) {
      weedRoots.push({ col: Math.floor(cols * 0.4), height: Math.min(waterDepth, 4), phase: 0.9 });
    }

    for (const weed of weedRoots) {
      if (weed.col <= 0 || weed.col >= cols - 1) continue;
      for (let k = 1; k <= weed.height; k++) {
        const r = floor - k;
        if (r <= 1) break;
        const sway = Math.sin(u * 1.5 + weed.phase + k * 0.4) * (k / weed.height) * 1.1;
        const weedC = Math.round(weed.col + sway);
        const glyph = sway > 0.35 ? ")" : sway < -0.35 ? "(" : "|";
        put(r, weedC, glyph, "success");
      }
    }

    // -----------------------------------------------------------------------
    // 6. Food Particles under Gravity
    // -----------------------------------------------------------------------
    const activeFoods = sim ? sim.foods.filter(f => !f.eaten) : [];
    for (const food of activeFoods) {
      const foodRow = Math.round(food.y);
      const wobble = Math.sin(food.y * 3.0 + food.id) * 0.4;
      const foodCol = Math.round(food.x + wobble);
      if (!food.settled) {
        if (foodRow >= 2 && foodRow < floor && foodCol > 0 && foodCol < cols - 1) {
          // Falling food flake/pellet under gravity (vibrant golden warning color)
          const flakeGlyph = (Math.floor(food.y * 2) % 2 === 0) ? "•" : "*";
          put(foodRow, foodCol, flakeGlyph, "warning");
        }
      } else {
        // Settled on gravel bed
        if (foodCol > 0 && foodCol < cols - 1) {
          put(floor, foodCol, "°", "warning");
        }
      }
    }

    // -----------------------------------------------------------------------
    // 7. Creature 1: Neon Tetra (1 line tall) - Cyan body, red tailfin, white eye
    // -----------------------------------------------------------------------
    {
      const minX = 3;
      const maxX = Math.max(minX + 2, cols - 10);
      const minY = 2;
      const maxY = Math.max(minY, floor - 1);

      // Autonomous 2D random wandering
      const tw = wander1D(u, 11);
      const wanderX = Math.round(minX + tw.pos * (maxX - minX));
      const wanderY = Math.round(minY + wanderDepth(u, 29) * (maxY - minY));
      let facing: "right" | "left" | "turn" = tw.vel > 0.003 ? "right" : tw.vel < -0.003 ? "left" : "turn";
      let x = wanderX;
      let y = wanderY;

      // Hunger and food awareness
      const hunger = sim ? sim.getHunger("tetra") : (0.5 + 0.45 * Math.sin(u * (2 * Math.PI / 24) + 1.2));
      const eatingTimer = sim?.eatingTimers.get("tetra") ?? 0;
      const isHungry = hunger >= 0.35;

      // Food seeking when hungry
      if (sim && isHungry && activeFoods.length > 0) {
        let bestFood: FoodParticle | undefined;
        let bestDist = Infinity;
        for (const f of activeFoods) {
          const d = Math.hypot(f.x - x, (f.y - y) * 2);
          if (d < bestDist) {
            bestDist = d;
            bestFood = f;
          }
        }
        if (bestFood) {
          const fx = bestFood.x;
          const fy = Math.round(bestFood.y);
          if (fx > x + 1) {
            x = Math.min(maxX, x + 1);
            facing = "right";
          } else if (fx < x - 1) {
            x = Math.max(minX, x - 1);
            facing = "left";
          } else {
            facing = "turn";
          }
          if (fy > y) y = Math.min(maxY, y + 1);
          else if (fy < y) y = Math.max(minY, y - 1);

          // Collision check: mouth touches food
          const mouthX = facing === "right" ? x + 6 : facing === "left" ? x : x + 3;
          if (Math.abs(mouthX - fx) <= 1 && Math.abs(y - fy) <= 1) {
            bestFood.eaten = true;
            sim.setHunger("tetra", 0);
            sim.eatingTimers.set("tetra", 1.6);
          }
        }
      }

      // Eye expression: happy ^ when eating, wide o/O when hungry, ° when satisfied
      const eye = eatingTimer > 0 ? "^" : hunger >= 0.7 ? "O" : hunger >= 0.35 ? "o" : "°";

      if (facing === "right") {
        put(y, x, "><", "error"); // Red tailfin
        put(y, x + 2, "(((", "accent"); // Electric blue body
        put(y, x + 5, eye, "text"); // White eye
        put(y, x + 6, ">", "accent"); // Snout
      } else if (facing === "left") {
        put(y, x, "<", "accent"); // Snout
        put(y, x + 1, eye, "text"); // White eye
        put(y, x + 2, ")))", "accent"); // Electric blue body
        put(y, x + 5, "><", "error"); // Red tailfin
      } else {
        put(y, x, "<(", "accent");
        put(y, x + 2, eye, "text");
        put(y, x + 3, eatingTimer > 0 ? "*" : "o", "text");
        put(y, x + 4, eye, "text");
        put(y, x + 5, ")>", "accent");
      }

      // Happy bubble when eating
      if (eatingTimer > 0 && y > 2) {
        put(y - 1, facing === "right" ? x + 6 : x, "°", "accent");
      }
    }

    // -----------------------------------------------------------------------
    // 8. Creature 2: Small Golden Minnow (1 line) - Gold body, white eye
    // -----------------------------------------------------------------------
    if (waterDepth >= 3 && cols >= 22) {
      const minX = 4;
      const maxX = Math.max(minX + 2, cols - 7);
      const minY = 2;
      const maxY = Math.max(minY, floor - 2);

      const mw = wander1D(u * 1.4, 47);
      const wanderX = Math.round(minX + mw.pos * (maxX - minX));
      const wanderY = Math.round(minY + wanderDepth(u * 1.3, 71) * (maxY - minY));
      let facing: "right" | "left" | "turn" = mw.vel > 0.003 ? "right" : mw.vel < -0.003 ? "left" : "turn";
      let x = wanderX;
      let y = wanderY;

      const hunger = sim ? sim.getHunger("minnow") : (0.5 + 0.45 * Math.sin(u * (2 * Math.PI / 18) + 3.4));
      const eatingTimer = sim?.eatingTimers.get("minnow") ?? 0;
      const isHungry = hunger >= 0.35;

      if (sim && isHungry && activeFoods.length > 0) {
        let bestFood: FoodParticle | undefined;
        let bestDist = Infinity;
        for (const f of activeFoods) {
          const d = Math.hypot(f.x - x, (f.y - y) * 2);
          if (d < bestDist) {
            bestDist = d;
            bestFood = f;
          }
        }
        if (bestFood) {
          const fx = bestFood.x;
          const fy = Math.round(bestFood.y);
          if (fx > x + 1) {
            x = Math.min(maxX, x + 1);
            facing = "right";
          } else if (fx < x - 1) {
            x = Math.max(minX, x - 1);
            facing = "left";
          } else {
            facing = "turn";
          }
          if (fy > y) y = Math.min(maxY, y + 1);
          else if (fy < y) y = Math.max(minY, y - 1);

          const mouthX = facing === "right" ? x + 3 : x;
          if (Math.abs(mouthX - fx) <= 1 && Math.abs(y - fy) <= 1) {
            bestFood.eaten = true;
            sim.setHunger("minnow", 0);
            sim.eatingTimers.set("minnow", 1.6);
          }
        }
      }

      const eye = eatingTimer > 0 ? "^" : hunger >= 0.7 ? "O" : hunger >= 0.35 ? "*" : "'";

      if (facing === "right") {
        put(y, x, "><", "warning");
        put(y, x + 2, eye, "text");
        put(y, x + 3, ">", "warning");
      } else if (facing === "left") {
        put(y, x, "<", "warning");
        put(y, x + 1, eye, "text");
        put(y, x + 2, "><", "warning");
      } else {
        put(y, x, "<", "warning");
        put(y, x + 1, eye, "text");
        put(y, x + 2, ">", "warning");
      }
    }

    // -----------------------------------------------------------------------
    // 9. Creature 3: Tropical Angelfish (2-3 lines tall) - Golden fin & accent stripes
    // -----------------------------------------------------------------------
    if (waterDepth >= 4 && cols >= 32) {
      const minX = 5;
      const maxX = Math.max(minX + 2, cols - 11);
      const minY = 2;
      const maxY = Math.max(minY, floor - 3);

      const aw = wander1D(u * 0.7, 83);
      const wanderX = Math.round(minX + aw.pos * (maxX - minX));
      const wanderY = Math.round(minY + wanderDepth(u * 0.6, 103) * (maxY - minY));
      let facing: "right" | "left" | "turn" = aw.vel > 0.003 ? "right" : aw.vel < -0.003 ? "left" : "turn";
      let x = wanderX;
      let y = wanderY;

      const hunger = sim ? sim.getHunger("angelfish") : (0.5 + 0.45 * Math.sin(u * (2 * Math.PI / 26) + 0.5));
      const eatingTimer = sim?.eatingTimers.get("angelfish") ?? 0;
      const isHungry = hunger >= 0.35;

      if (sim && isHungry && activeFoods.length > 0) {
        let bestFood: FoodParticle | undefined;
        let bestDist = Infinity;
        for (const f of activeFoods) {
          const d = Math.hypot(f.x - x, (f.y - y) * 2);
          if (d < bestDist) {
            bestDist = d;
            bestFood = f;
          }
        }
        if (bestFood) {
          const fx = bestFood.x;
          const fy = Math.round(bestFood.y);
          if (fx > x + 1) {
            x = Math.min(maxX, x + 1);
            facing = "right";
          } else if (fx < x - 1) {
            x = Math.max(minX, x - 1);
            facing = "left";
          } else {
            facing = "turn";
          }
          if (fy > y) y = Math.min(maxY, y + 1);
          else if (fy < y) y = Math.max(minY, y - 1);

          const mouthX = facing === "right" ? x + 5 : x;
          if (Math.abs(mouthX - fx) <= 1 && Math.abs(y + 1 - fy) <= 1) {
            bestFood.eaten = true;
            sim.setHunger("angelfish", 0);
            sim.eatingTimers.set("angelfish", 1.6);
          }
        }
      }

      const eye = eatingTimer > 0 ? "^" : hunger >= 0.7 ? "O" : hunger >= 0.35 ? "•" : "'";

      if (facing === "right") {
        put(y, x + 1, "\\", "warning");
        put(y + 1, x, ">=", "warning");
        put(y + 1, x + 2, "_(" + eye, "accent");
        put(y + 1, x + 5, ">", "warning");
        if (y + 2 < floor) put(y + 2, x + 1, "/", "warning");
      } else if (facing === "left") {
        put(y, x + 1, "/", "warning");
        put(y + 1, x, "<", "warning");
        put(y + 1, x + 1, eye + ")_", "accent");
        put(y + 1, x + 4, "=<", "warning");
        if (y + 2 < floor) put(y + 2, x + 1, "\\", "warning");
      } else {
        put(y, x + 1, "|", "warning");
        put(y + 1, x, "<(", "warning");
        put(y + 1, x + 2, eye, "text");
        put(y + 1, x + 3, ")>", "warning");
        if (y + 2 < floor) put(y + 2, x + 1, "|", "warning");
      }
    }

    // -----------------------------------------------------------------------
    // 10. Creature 4: Pulsing Jellyfish
    // -----------------------------------------------------------------------
    if (cols >= 38 && waterDepth >= 4) {
      const jellyCycle = 16.0;
      const jProg = (u % jellyCycle) / jellyCycle;
      const jRow = Math.round(floor - 2 - jProg * (waterDepth - 1));
      const drift = Math.sin(u * (2 * Math.PI / 24) + 1.5) * Math.min(8, Math.floor(cols * 0.15));
      const jellyCol = Math.max(4, Math.min(cols - 8, Math.round(cols * 0.72 + drift)));
      const pulse = Math.floor(u * 2) % 2 === 0;

      const hunger = sim ? sim.getHunger("jellyfish") : (0.5 + 0.45 * Math.sin(u * (2 * Math.PI / 20) + 2.1));
      const eatingTimer = sim?.eatingTimers.get("jellyfish") ?? 0;

      // Jellyfish tentacles catch sinking food
      if (sim && hunger >= 0.35 && activeFoods.length > 0) {
        for (const f of activeFoods) {
          if (Math.abs(f.x - jellyCol) <= 2 && Math.abs(f.y - jRow) <= 2) {
            f.eaten = true;
            sim.setHunger("jellyfish", 0);
            sim.eatingTimers.set("jellyfish", 1.6);
            break;
          }
        }
      }

      const face = eatingTimer > 0 ? "(^ ^)" : hunger >= 0.5 ? "(• •)" : pulse ? "(o o)" : "( - )";

      if (jRow >= 2 && jRow < floor) {
        put(jRow, jellyCol, ".-.", "accent");
        put(jRow + 1, jellyCol - 1, face, "accent");
        put(jRow + 2, jellyCol, pulse ? "~ ~" : "| |", "dim");
      }
    }

    // -----------------------------------------------------------------------
    // 11. Creature 5: Little Crab on gravel bed
    // -----------------------------------------------------------------------
    if (cols >= 30) {
      const crabMin = 5;
      const crabMax = Math.max(crabMin + 2, stoneCol - 7);
      const cw = wander1D(u * 0.8, 137);
      let crabX = Math.round(crabMin + cw.pos * (crabMax - crabMin));

      const hunger = sim ? sim.getHunger("crab") : (0.5 + 0.45 * Math.sin(u * (2 * Math.PI / 22) + 4.5));
      const eatingTimer = sim?.eatingTimers.get("crab") ?? 0;
      const isHungry = hunger >= 0.35;

      // Crab scuttles toward food on gravel
      if (sim && isHungry && activeFoods.length > 0) {
        let bestGravelFood: FoodParticle | undefined;
        let bestDist = Infinity;
        for (const f of activeFoods) {
          if (f.settled || f.y >= floor - 1.5) {
            const d = Math.abs(f.x - crabX);
            if (d < bestDist) {
              bestDist = d;
              bestGravelFood = f;
            }
          }
        }
        if (bestGravelFood) {
          crabX = Math.round(crabX + Math.sign(bestGravelFood.x - (crabX + 2)));
          crabX = Math.max(crabMin, Math.min(crabMax, crabX));
          if (Math.abs(crabX + 2 - bestGravelFood.x) <= 2) {
            bestGravelFood.eaten = true;
            sim.setHunger("crab", 0);
            sim.eatingTimers.set("crab", 1.6);
          }
        }
      }

      const crabSprite =
        eatingTimer > 0
          ? "(\\^^/)"
          : hunger >= 0.5
          ? "(\\??/)"
          : Math.abs(cw.vel) > 0.003 && Math.floor(u * 4) % 2 === 0
          ? "(\\,,/)"
          : "(\\_/)";

      put(floor, crabX, crabSprite, "error");
    }

    // Render cells to styled lines
    const fg = theme?.fg ? theme.fg.bind(theme) : (_token: ThemeToken, text: string) => text;
    return grid.map(row => {
      let line = "";
      let currentToken: ThemeToken | undefined;
      let span = "";

      for (const cell of row) {
        if (cell.color === currentToken) {
          span += cell.char;
        } else {
          if (span) {
            line += currentToken ? fg(currentToken, span) : span;
          }
          currentToken = cell.color;
          span = cell.char;
        }
      }
      if (span) {
        line += currentToken ? fg(currentToken, span) : span;
      }
      return line;
    });
  };
}

export function createAquarium(
  cols: number,
  rows: number,
  simulation?: AquariumSimulation
): ((seconds: number, theme?: AquariumTheme) => string[]) & {
  dropFood: (col?: number) => FoodParticle;
  clearFoods: () => void;
  sim: AquariumSimulation;
} {
  if (!Number.isInteger(cols) || cols < 12 || cols > 120 || !Number.isInteger(rows) || rows < 6 || rows > 30) {
    throw new RangeError("Aquarium requires 12–120 columns and 6–30 rows");
  }

  const effectiveSim = simulation ?? getAquariumSimulation(cols, rows);
  effectiveSim.resize(cols, rows);
  const jsRenderer = createJsAquarium(cols, rows, effectiveSim);

  const renderer = (seconds: number, theme?: AquariumTheme): string[] => {
    // If food particles exist, always use the JS simulation renderer to render falling food & hungry biota
    if (effectiveSim.hasActiveFoods()) {
      return jsRenderer(seconds, theme);
    }

    // When a Pi theme is available, always use the themed JS renderer to format
    // directly through theme.fg() with the user's active theme palette.
    if (theme && typeof theme.fg === "function") {
      return jsRenderer(seconds, theme);
    }

    // Pure uncolored rendering: use extensible Rust WASM engine for instant microsecond execution
    const wasmFrame = renderWasmScene("aquarium", cols, rows, seconds, false);
    if (wasmFrame) {
      return wasmFrame;
    }

    return jsRenderer(seconds, theme);
  };

  renderer.dropFood = (col?: number) => effectiveSim.dropFood(col);
  renderer.clearFoods = () => effectiveSim.clearFoods();
  renderer.sim = effectiveSim;

  return renderer;
}

/** One unref'd clock per mounted sidebar. Recheck visibility before each tick;
 * a hidden/narrow/short/regular renderer must never generate background redraws. */
export class AquariumAnimation {
  private timer?: ReturnType<typeof setInterval>;
  private disposed = false;
  private frame = 0;
  private scene?: ReturnType<typeof createAquarium>;
  private dimensions = "";
  private sim?: AquariumSimulation;
  private readonly visible: () => boolean;
  private readonly redraw: () => void;

  constructor(visible: () => boolean, redraw: () => void) {
    this.visible = visible;
    this.redraw = redraw;
  }

  dropFood(col?: number): boolean {
    if (this.sim) {
      this.sim.dropFood(col);
      return true;
    }
    return feedAquarium(col);
  }

  handleMouse(
    event: { type?: string; x: number; y: number },
    bounds: { x: number; y: number; width: number; height: number }
  ): { handled: boolean; render: boolean } | undefined {
    const tankX = event.x - bounds.x;
    const tankY = event.y - bounds.y;
    // Click in top position of fish tank (top rim, water surface, upper water)
    if (tankY <= 2 && tankX >= 1 && tankX <= bounds.width - 2) {
      this.dropFood(tankX);
      return { handled: true, render: true };
    }
  }

  sync(): void {
    if (this.disposed || !this.visible()) {
      if (this.timer) clearInterval(this.timer);
      this.timer = undefined;
    } else if (!this.timer) {
      this.timer = setInterval(() => {
        if (this.disposed || !this.visible()) {
          this.sync();
          return;
        }
        this.frame++;
        this.redraw();
      }, 1000 / AQUARIUM_FPS);
      this.timer.unref?.();
    }
  }

  render(width: number, height: number, theme?: AquariumTheme): string[] {
    const dimensions = `${width}x${height}`;
    if (dimensions !== this.dimensions) {
      this.sim = getAquariumSimulation(width, height);
      this.scene = createAquarium(width, height, this.sim);
      this.dimensions = dimensions;
    }
    return this.scene!(this.frame / AQUARIUM_FPS, theme);
  }

  dispose(): void {
    this.disposed = true;
    this.sync();
  }
}
