/* Natural Slow-Paced Autonomous Cat Arena for Pi Sidebar.
 * Features responsive multi-cat playground (Mochi, Kuro, Pip the shelf kitten),
 * autonomous random episodes, cozy slow-paced animations, and smooth dither transitions.
 * Supports theme tokens (accent, muted, dim, warning, success, error, text).
 * Compatible with Pi TUI dimensions and responsive widths (18 to 60+ cols, 6 to 10 rows).
 */
import type { AquariumTheme, ThemeToken } from "./sidebar-aquarium.ts";
import type { AsciiAnimationPiece } from "./sidebar-animation.ts";

export const CATS_FPS = 8;
export const CATS_MIN_HEIGHT = 6;
export const CATS_MAX_HEIGHT = 10;

interface Cell {
  char: string;
  color: ThemeToken;
}

// ── Sprites ────────────────────────────────────────────────────────
const SPRITES = {
  // 3-row compact / floor cat sprites (fits height 6..10)
  mochiIdleR: [
    " (\\ /\\_/\\",
    "  \\( •.• )",
    " (__/  \\__)",
  ],
  mochiWalkR1: [
    " (\\ /\\_/\\",
    "  \\( •.• )",
    " (_/   \\_)",
  ],
  mochiWalkR2: [
    " (\\ /\\_/\\",
    "  \\( •.• )",
    " (__/  \\__)",
  ],
  mochiWalkR3: [
    " (\\ /\\_/\\",
    "  \\( •.• )",
    "   \\_) (_/",
  ],
  mochiBlinkR: [
    " (\\ /\\_/\\",
    "  \\( -.- )",
    " (__/  \\__)",
  ],
  mochiWiggleR1: [
    "  _ /\\_/\\",
    " (\\( •.• )",
    " (___  ___)",
  ],
  mochiWiggleR2: [
    "  _ /\\_/\\",
    " _/\\( >.< )",
    " (___  ___)",
  ],
  mochiStalkR: [
    "    /\\_/\\",
    " ~\\( ☉.☉ )",
    " (__/  \\__)",
  ],
  mochiJumpR: [
    "   /\\_/\\",
    " \\( ^o^ )",
    " (_/   \\_)",
  ],
  mochiGroomR: [
    " (\\ /\\_/\\",
    "  \\( 'w' )",
    " (__/(>o )",
  ],
  mochiStretchR: [
    "    /\\_/\\",
    " ~~( =O= )",
    " (__/  \\__)",
  ],
  mochiSitR: [
    "  /\\_/\\",
    " ( •.• )",
    " (_|___|)~",
  ],
  mochiSitR1: [
    "  /\\_/\\",
    " ( •.• )",
    " (_|___|)~",
  ],
  mochiSitR2: [
    "  /\\_/\\",
    " ( •.• )",
    " (_|___|)/",
  ],
  mochiSitBlinkR: [
    "  /\\_/\\",
    " ( -.- )",
    " (_|___|)~",
  ],
  mochiSitLookUpR: [
    "  /\\_/\\",
    " ( ☉.☉ )^",
    " (_|___|)~",
  ],
  mochiLoafBreathe1: [
    "   /\\_/\\",
    "  ( -.- )",
    " (_______)~",
  ],
  mochiLoafBreathe2: [
    "   /\\_/\\",
    "  ( •.• )",
    " (_______)-",
  ],
  mochiGroomPaw: [
    " (\\ /\\_/\\",
    "  \\( 'w' )",
    " (__/(>o )",
  ],
  mochiGroomEar: [
    " (\\ /\\_/\\",
    "  \\( >.< )/",
    " (__/  \\__)",
  ],
  mochiGroomSatisfied: [
    " (\\ /\\_/\\",
    "  \\( ^.^ )",
    " (__/  \\__)~",
  ],

  // Facing Left
  mochiIdleL: [
    "/\\_/\\ /)",
    "( •.• )/ ",
    "(__/  \\__)",
  ],
  mochiWalkL1: [
    "/\\_/\\ /)",
    "( •.• )/ ",
    "(_/   \\_)",
  ],
  mochiWalkL2: [
    "/\\_/\\ /)",
    "( •.• )/ ",
    "(__/  \\__)",
  ],
  mochiWalkL3: [
    "/\\_/\\ /)",
    "( •.• )/ ",
    " (\\_)(_/ ",
  ],
  mochiBlinkL: [
    "/\\_/\\ /)",
    "( -.- )/ ",
    "(__/  \\__)",
  ],
  mochiWiggleL1: [
    "/\\_/\\ _ ",
    "( •.• )/) ",
    "(___  ___)",
  ],
  mochiWiggleL2: [
    "/\\_/\\ _ ",
    "( >.< )/\\_ ",
    "(___  ___)",
  ],
  mochiStalkL: [
    "/\\_/\\   ",
    "( ☉.☉ )/~",
    "(__/  \\__)",
  ],
  mochiJumpL: [
    "/\\_/\\   ",
    "( ^o^ )/ ",
    "(_/   \\_)",
  ],
  mochiGroomL: [
    "/\\_/\\ /)",
    "( 'w' )/ ",
    "( o< )\\__)",
  ],
  mochiStretchL: [
    "/\\_/\\   ",
    "( =O= )~~",
    "(__/  \\__)",
  ],
  mochiSitL: [
    "  /\\_/\\",
    " ( •.• )",
    "~(_|___|_)",
  ],
  mochiSitL1: [
    "  /\\_/\\",
    " ( •.• )",
    "~(_|___|_)",
  ],
  mochiSitL2: [
    "  /\\_/\\",
    " ( •.• )",
    "/(_|___|_)",
  ],
  mochiSitBlinkL: [
    "  /\\_/\\",
    " ( -.- )",
    "~(_|___|_)",
  ],
  mochiSitLookUpL: [
    "  /\\_/\\",
    "^( ☉.☉ )",
    "~(_|___|_)",
  ],
  mochiGroomPawL: [
    "/\\_/\\ /)",
    "( 'w' )/ ",
    "( o<)\\__) ",
  ],
  mochiGroomEarL: [
    "/\\_/\\ /)",
    "\\( >.< ) ",
    "(__/  \\__)",
  ],
  mochiGroomSatisfiedL: [
    "/\\_/\\ /)",
    "( ^.^ )/ ",
    "~(__/  \\__)",
  ],

  // Kuro (Striped Tabby)
  kuroIdleR: [
    " (\\ /\\_/\\",
    "  \\≡( •.• )",
    " (__/  \\__)",
  ],
  kuroWalkR1: [
    " (\\ /\\_/\\",
    "  \\≡( •.• )",
    " (_/   \\_)",
  ],
  kuroWalkR2: [
    " (\\ /\\_/\\",
    "  \\≡( •.• )",
    " (__/  \\__)",
  ],
  kuroWalkR3: [
    " (\\ /\\_/\\",
    "  \\≡( •.• )",
    "   \\_) (_/",
  ],
  kuroIdleL: [
    "/\\_/\\ /)",
    "( •.• )≡/ ",
    "(__/  \\__)",
  ],
  kuroWalkL1: [
    "/\\_/\\ /)",
    "( •.• )≡/ ",
    "(_/   \\_)",
  ],
  kuroWalkL2: [
    "/\\_/\\ /)",
    "( •.• )≡/ ",
    "(__/  \\__)",
  ],
  kuroWalkL3: [
    "/\\_/\\ /)",
    "( •.• )≡/ ",
    " (\\_)(_/ ",
  ],
  kuroLoafSleep: [
    " /\\_/\\   ",
    "( -.- )≡_",
    "(________)",
  ],
  kuroLoafWake: [
    " /\\_/\\   ",
    "( ☉.☉ )≡_",
    "(________)",
  ],
  kuroLoafWake1: [
    " /\\_/\\   ",
    "( •.• )≡_",
    "(________)",
  ],
  kuroLoafWake2: [
    " /\\_/\\   ",
    "( ☉.☉ )≡_",
    "(______)/ ",
  ],
  kuroIdleSwishR1: [
    " (\\ /\\_/\\",
    "  \\≡( •.• )",
    " (__/  \\__)",
  ],
  kuroIdleSwishR2: [
    " // /\\_/\\",
    "  \\≡( •.• )",
    " (__/  \\__)",
  ],
  kuroIdleBlinkR: [
    " (\\ /\\_/\\",
    "  \\≡( -.- )",
    " (__/  \\__)",
  ],
  kuroIdleSwishL1: [
    "/\\_/\\ /)",
    "( •.• )≡/ ",
    "(__/  \\__)",
  ],
  kuroIdleSwishL2: [
    "/\\_/\\ \\\\",
    "( •.• )≡/ ",
    "(__/  \\__)",
  ],
  kuroIdleBlinkL: [
    "/\\_/\\ /)",
    "( -.- )≡/ ",
    "(__/  \\__)",
  ],
  kuroLookUpL: [
    "/\\_/\\ ^ ",
    "( ☉.☉ )≡/ ",
    "(__/  \\__)",
  ],
  catInBoxHappy: [
    " /\\_/\\  ",
    "+( ^.^)+",
    "|[BOX] |",
  ],
  catBoxButt1: [
    " (\\    ",
    "+ \\__ +",
    "|[BOX] |",
  ],
  catBoxButt2: [
    "  /)   ",
    "+/__/ +",
    "|[BOX] |",
  ],

  // Tumble / Wrestling cloud
  tumble1: [
    " _ /\\_/\\",
    "(( ^.^ )",
    "(_/ >.<)",
  ],
  tumble2: [
    "/\\_/\\ _ ",
    "( >.< ))",
    " _/( ^.^)",
  ],

  // Cardboard Box
  boxEmpty: [
    "+------+",
    "|[BOX] |",
    "+------+",
  ],
  catInBox: [
    " /\\_/\\  ",
    "+( •.•)+",
    "|[BOX] |",
  ],
  catBoxButt: [
    " (\\    ",
    "+ \\__ +",
    "|[BOX] |",
  ],

  // Shelf Kitten (Pip)
  pipSleep: [
    "/\\_/\\",
    "(-.-)",
  ],
  pipSit: [
    "/\\_/\\",
    "(•.•)",
  ],
  pipTap: [
    "/\\_/\\",
    "(•.•)/",
  ],
  pipLookUp: [
    "/\\_/\\",
    "(☉.☉)^",
  ],
};

function stampToGrid(
  grid: Cell[][],
  spriteLines: string[],
  startX: number,
  startY: number,
  color: ThemeToken = "text"
): void {
  const H = grid.length;
  const W = grid[0]!.length;
  for (let r = 0; r < spriteLines.length; r++) {
    const gy = Math.round(startY) + r;
    if (gy <= 0 || gy >= H - 1) continue;
    const line = spriteLines[r]!;
    const first = line.search(/\S/);
    const last = line.trimEnd().length - 1;
    if (first === -1) continue;
    for (let c = first; c <= last; c++) {
      const gx = Math.round(startX) + c;
      if (gx > 0 && gx < W - 1) {
        grid[gy]![gx] = { char: line[c]!, color };
      }
    }
  }
}

function stampTextToGrid(
  grid: Cell[][],
  text: string,
  x: number,
  y: number,
  color: ThemeToken = "text"
): void {
  const H = grid.length;
  const W = grid[0]!.length;
  const gy = Math.round(y);
  // Reserve row 1 for open sky passer when height is compact (H < 7)
  if (gy <= (H >= 7 ? 0 : 1) || gy >= H - 1) return;
  const gx = Math.round(x);
  for (let i = 0; i < text.length; i++) {
    const col = gx + i;
    if (col > 0 && col < W - 1) {
      grid[gy]![col] = { char: text[i]!, color };
    }
  }
}

function pseudoNoise(x: number, y: number): number {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// ── Active Lively Cat Animators (Zero Freezes) ──────────────────────
function getActiveMochi(
  state: "idle" | "sit" | "loaf" | "groom" | "stalk",
  sec: number,
  facing: "R" | "L" = "R"
): string[] {
  const blinkCycle = Math.floor(sec * 1.6) % 6 === 0;

  if (state === "sit") {
    if (blinkCycle) return facing === "R" ? SPRITES.mochiSitBlinkR : SPRITES.mochiSitBlinkL;
    const swish = Math.floor(sec * 2.5) % 2 === 0;
    return facing === "R"
      ? (swish ? SPRITES.mochiSitR1 : SPRITES.mochiSitR2)
      : (swish ? SPRITES.mochiSitL1 : SPRITES.mochiSitL2);
  }

  if (state === "loaf") {
    const breathe = Math.floor(sec * 1.5) % 2 === 0;
    return breathe ? SPRITES.mochiLoafBreathe1 : SPRITES.mochiLoafBreathe2;
  }

  if (state === "groom") {
    const groomPhase = Math.floor(sec * 2) % 3;
    if (groomPhase === 0) return facing === "R" ? SPRITES.mochiGroomPaw : SPRITES.mochiGroomPawL;
    if (groomPhase === 1) return facing === "R" ? SPRITES.mochiGroomEar : SPRITES.mochiGroomEarL;
    return facing === "R" ? SPRITES.mochiGroomSatisfied : SPRITES.mochiGroomSatisfiedL;
  }

  if (state === "stalk") {
    const wiggle = Math.floor(sec * 4) % 2 === 0;
    return facing === "R"
      ? (wiggle ? SPRITES.mochiWiggleR1 : SPRITES.mochiWiggleR2)
      : (wiggle ? SPRITES.mochiWiggleL1 : SPRITES.mochiWiggleL2);
  }

  if (blinkCycle) return facing === "R" ? SPRITES.mochiBlinkR : SPRITES.mochiBlinkL;
  const tailUp = Math.floor(sec * 2) % 2 === 0;
  return facing === "R"
    ? (tailUp ? SPRITES.mochiIdleR : SPRITES.mochiWalkR2)
    : (tailUp ? SPRITES.mochiIdleL : SPRITES.mochiWalkL2);
}

function getActiveKuro(
  state: "loaf" | "idle" | "walk" | "watch",
  sec: number,
  facing: "R" | "L" = "L"
): string[] {
  const blinkCycle = Math.floor(sec * 1.8) % 7 === 0;

  if (state === "loaf") {
    const breathe = Math.floor(sec * 1.2) % 2 === 0;
    return breathe ? SPRITES.kuroLoafWake1 : SPRITES.kuroLoafWake2;
  }

  if (blinkCycle) return facing === "R" ? SPRITES.kuroIdleBlinkR : SPRITES.kuroIdleBlinkL;
  const swish = Math.floor(sec * 2.2) % 2 === 0;
  return facing === "R"
    ? (swish ? SPRITES.kuroIdleSwishR1 : SPRITES.kuroIdleSwishR2)
    : (swish ? SPRITES.kuroIdleSwishL1 : SPRITES.kuroIdleSwishL2);
}

// ── Smooth Sky Celestial Passers (UFO, Satellite, Sun, Moon) ────────
function renderSkyPasser(grid: Cell[][], cols: number, rows: number, seconds: number): void {
  if (cols < 20 || rows < 6) return;

  const CYCLE_TIME = 26.0;
  const passerIdx = Math.floor(seconds / CYCLE_TIME) % 4;
  const progress = (seconds % CYCLE_TIME) / CYCLE_TIME;

  const passerY = 1;
  const travelW = cols + 16;
  const passerX = Math.round(progress * travelW) - 8;

  let sprite = "";
  let color: ThemeToken = "accent";
  let beam = false;

  if (passerIdx === 0) {
    // 🛸 Flying Saucer / UFO gliding across the room
    sprite = "<(o)>";
    color = "accent";
    beam = Math.floor(seconds * 3) % 2 === 0;
  } else if (passerIdx === 1) {
    // 🛰️ Orbiting Satellite
    sprite = "|=o=|";
    color = "muted";
  } else if (passerIdx === 2) {
    // ☀️ Radiant Sun
    sprite = "\\(*)/";
    color = "warning";
  } else {
    // 🌙 Crescent Moon
    sprite = "( ☾ )";
    color = "text";
  }

  for (let i = 0; i < sprite.length; i++) {
    const gx = passerX + i;
    // Don't collide with Pip's high shelf on the top-right if present
    const shelfBlocked = rows >= 8 && cols >= 28 && gx >= cols - 12;
    if (gx > 1 && gx < cols - 2 && !shelfBlocked) {
      grid[passerY]![gx] = { char: sprite[i]!, color };
    }
  }

  // Soft scanning beacon dot beneath UFO
  if (beam && passerX > 2 && passerX < cols - 6 && rows >= 7) {
    const beamX = passerX + 2;
    if (grid[passerY + 1] && grid[passerY + 1]![beamX]?.char === " ") {
      grid[passerY + 1]![beamX] = { char: "·", color: "dim" };
    }
  }
}

// ── Episodes & Story Engine ─────────────────────────────────────────
type CatScene = "laser" | "box" | "ball" | "treat" | "nap" | "scuffle";
const SCENES: CatScene[] = ["laser", "box", "ball", "treat", "nap", "scuffle"];

export const catsPiece: AsciiAnimationPiece = {
  id: "cats",
  name: "Cat Arena",
  description: "Slow-paced autonomous cats playground (laser chase, box sits, yarn play, treat feast, naps, scuffle)",
  fps: CATS_FPS,
  minHeight: CATS_MIN_HEIGHT,
  maxHeight: CATS_MAX_HEIGHT,
  render(cols: number, rows: number, seconds: number, theme?: AquariumTheme) {
    return createCatsArena(cols, rows)(seconds, theme);
  },
};

export function createCatsArena(cols: number, rows: number): (seconds: number, theme?: AquariumTheme) => string[] {

  const innerW = cols - 2;
  const innerH = rows - 2;
  const floor = rows - 2;
  const catH = 3;
  const catY = floor - catH + 1; // Paws land on floor row

  // Natural slow episode pacing: ~24 seconds per story arc
  const EPISODE_DURATION = 24.0;
  const TRANSITION_DURATION = 2.6; // 2.6s relaxed walk transition

  function renderSingleScene(grid: Cell[][], scene: CatScene, localSec: number) {
    const mid = Math.floor(cols / 2);
    const wide = cols >= 32;

    if (scene === "laser") {
      // The Mysterious Red Dot
      const cycle = localSec % 16;
      let lx = mid, ly = floor - 1;
      let mochiSprite = SPRITES.mochiStalkR;
      let mochiX = Math.max(2, mid - 12);
      let mochiY = catY;

      if (cycle < 5) {
        // Dot dancing gently; Mochi stalks forward with active leg locomotion
        const p = cycle / 5;
        mochiX = Math.round(mid - 12 + p * 5);
        lx = Math.floor(mid - 3 + Math.sin(localSec * 1.8) * Math.min(8, innerW / 3));
        ly = floor - (Math.sin(localSec * 2.2) > 0.5 ? 2 : 1);
        mochiSprite = getActiveMochi("stalk", localSec, "R");
        stampTextToGrid(grid, "!", mochiX + 5, mochiY - 1, "warning");
      } else if (cycle < 10) {
        // Pounce leap!
        const p = (cycle - 5) / 5;
        mochiX = Math.max(2, Math.min(cols - 12, mid - 7 + p * 8));
        const arc = Math.sin(p * Math.PI) * Math.min(2.5, innerH - 3);
        mochiY = catY - arc;
        mochiSprite = p < 0.6 ? SPRITES.mochiJumpR : SPRITES.mochiStalkR;
        lx = Math.floor(mid + 2);
      } else {
        // Dot vanished: active confused look, ear twitches, tail swishes, looks up
        mochiX = mid - 2;
        if (cycle < 13) {
          mochiSprite = getActiveMochi("sit", localSec, "R");
          stampTextToGrid(grid, "?", mochiX + 3, mochiY - 1, "muted");
        } else {
          // Looking up at sky passer
          mochiSprite = SPRITES.mochiSitLookUpR;
          stampTextToGrid(grid, "?", mochiX + 3, mochiY - 1, "muted");
        }
        lx = -1; // dot vanished
      }

      stampToGrid(grid, mochiSprite, mochiX, mochiY, "text");
      if (lx > 0 && lx < cols - 1 && ly > 0 && ly < rows - 1) {
        grid[ly]![lx] = { char: "•", color: "error" };
      }

      if (wide) {
        // Kuro watching actively
        stampToGrid(grid, getActiveKuro("watch", localSec, "L"), cols - 12, catY, "dim");
      }
    } else if (scene === "box") {
      // If I Fits, I Sits
      const boxX = wide ? mid - 4 : cols - 10;
      const cycle = localSec % 16;

      if (cycle < 6) {
        stampToGrid(grid, SPRITES.boxEmpty, boxX, catY, "muted");
        const kx = Math.max(2, Math.round(boxX - 10 + (cycle / 6) * 7));
        const kFrame = Math.floor(localSec * 3.5) % 3;
        const kSp = kFrame === 0 ? SPRITES.kuroWalkR1 : kFrame === 1 ? SPRITES.kuroWalkR2 : SPRITES.kuroWalkR3;
        stampToGrid(grid, kSp, kx, catY, "dim");
      } else if (cycle < 12) {
        const inBoxSp = Math.floor(localSec * 2) % 2 === 0 ? SPRITES.catInBox : SPRITES.catInBoxHappy;
        stampToGrid(grid, inBoxSp, boxX, catY, "accent");
        stampTextToGrid(grid, "♥", boxX + 3, catY - 1, "error");
        if (wide) {
          stampToGrid(grid, getActiveMochi("groom", localSec, "R"), 3, catY, "text");
        }
      } else {
        const buttSp = Math.floor(localSec * 2.5) % 2 === 0 ? SPRITES.catBoxButt1 : SPRITES.catBoxButt2;
        stampToGrid(grid, buttSp, boxX, catY, "text");
        stampTextToGrid(grid, "~", boxX + 1, catY - 1, "muted");
        if (wide) {
          stampToGrid(grid, getActiveMochi("sit", localSec, "R"), 3, catY, "text");
        }
      }
    } else if (scene === "ball") {
      // Yarn Ball Play
      const cycle = localSec % 16;
      const ballX = Math.max(3, Math.min(cols - 4, Math.round(mid + Math.sin(localSec * 1.5) * (innerW * 0.35))));
      const ballY = floor - (Math.abs(Math.cos(localSec * 3.0)) > 0.6 ? 2 : 1);
      const catX = Math.max(2, Math.min(cols - 12, ballX - 7));

      const isRunning = Math.abs(Math.cos(localSec * 1.5)) > 0.3;
      let sp: string[];
      if (isRunning) {
        const walkFrame = Math.floor(localSec * 5) % 3;
        sp = walkFrame === 0 ? SPRITES.mochiWalkR1 : walkFrame === 1 ? SPRITES.mochiWalkR2 : SPRITES.mochiWalkR3;
      } else {
        sp = getActiveMochi("stalk", localSec, "R");
      }
      stampToGrid(grid, sp, catX, catY, "text");

      if (ballY > 0 && ballY < rows - 1 && ballX > 0 && ballX < cols - 1) {
        grid[ballY]![ballX] = { char: "@", color: "accent" };
        if (ballX - 1 > 0) grid[ballY]![ballX - 1] = { char: "~", color: "muted" };
      }

      if (wide) {
        stampToGrid(grid, getActiveKuro("watch", localSec, "L"), cols - 11, catY, "dim");
      }
    } else if (scene === "treat") {
      // Fish snack feast
      const fishX = mid - 2;
      const cycle = localSec % 16;

      if (cycle < 6) {
        const fy = Math.min(floor, 1 + Math.floor((cycle / 6) * (floor - 1)));
        stampTextToGrid(grid, "><(°>", fishX, fy, "success");
        const walkFrame = Math.floor(localSec * 3.5) % 3;
        const sp = walkFrame === 0 ? SPRITES.mochiWalkR1 : walkFrame === 1 ? SPRITES.mochiWalkR2 : SPRITES.mochiWalkR3;
        stampToGrid(grid, sp, Math.max(2, mid - 11), catY, "text");
      } else {
        stampTextToGrid(grid, "><(°>", fishX, floor, "dim");
        stampToGrid(grid, getActiveMochi("groom", localSec, "R"), Math.max(2, mid - 9), catY, "text");
        stampTextToGrid(grid, "*nom*", mid - 7, catY - 1, "warning");
        if (wide) {
          stampToGrid(grid, getActiveKuro("loaf", localSec, "L"), Math.min(cols - 11, mid + 3), catY, "dim");
          stampTextToGrid(grid, "♥", mid + 5, catY - 1, "error");
        }
      }
    } else if (scene === "nap") {
      // Slow leisurely afternoon nap & stretch
      const cycle = localSec % 16;
      let sp: string[];
      if (cycle < 6) {
        sp = getActiveMochi("groom", localSec, "R");
      } else if (cycle < 10) {
        sp = Math.floor(localSec * 2) % 2 === 0 ? SPRITES.mochiStretchR : SPRITES.mochiIdleR;
      } else {
        sp = getActiveMochi("loaf", localSec, "R");
      }
      stampToGrid(grid, sp, Math.max(2, mid - 8), catY, "text");

      const zY = catY - 1 - (Math.floor(localSec * 0.8) % 2);
      stampTextToGrid(grid, "z Z", mid - 1, zY, "muted");

      if (wide) {
        stampToGrid(grid, getActiveKuro("loaf", localSec, "L"), cols - 12, catY, "dim");
        stampTextToGrid(grid, "~purr~", cols - 10, catY - 1, "dim");
      }
    } else {
      // Scuffle: comic standoff & tumble
      const cycle = localSec % 16;
      if (cycle < 6) {
        stampToGrid(grid, getActiveMochi("stalk", localSec, "R"), Math.max(2, mid - 9), catY, "text");
        if (wide) {
          stampToGrid(grid, getActiveKuro("watch", localSec, "L"), Math.min(cols - 11, mid + 2), catY, "dim");
          stampTextToGrid(grid, "!", mid - 4, catY - 1, "warning");
          stampTextToGrid(grid, "!", mid + 3, catY - 1, "warning");
        }
      } else if (cycle < 12) {
        // Rolling tumble cloud
        const tumbleSp = Math.floor(localSec * 4) % 2 === 0 ? SPRITES.tumble1 : SPRITES.tumble2;
        stampToGrid(grid, tumbleSp, mid - 4, catY, "warning");
        stampTextToGrid(grid, "✦ *", mid - 2, catY - 1, "accent");
      } else {
        stampToGrid(grid, getActiveMochi("groom", localSec, "R"), Math.max(2, mid - 9), catY, "text");
        if (wide) {
          stampToGrid(grid, getActiveKuro("loaf", localSec, "L"), Math.min(cols - 11, mid + 2), catY, "dim");
        }
      }
    }

    // Shelf Kitten (Pip) on top right when tall enough (rows >= 8 and cols >= 28)
    if (rows >= 8 && cols >= 28) {
      const shelfW = 9;
      const sx = cols - shelfW - 2;
      const sy = 2;

      for (let i = 0; i < shelfW; i++) {
        grid[sy]![sx + i] = { char: "═", color: "dim" };
      }
      grid[sy]![sx] = { char: "╞", color: "dim" };
      grid[sy]![sx + shelfW - 1] = { char: "╡", color: "dim" };

      const pipMood = Math.floor(localSec / 4) % 4;
      const pipSp = pipMood === 0
        ? SPRITES.pipSleep
        : pipMood === 1
        ? SPRITES.pipSit
        : pipMood === 2
        ? SPRITES.pipTap
        : SPRITES.pipLookUp;
      stampToGrid(grid, pipSp, sx + 2, sy - 2, "muted");
      if (pipMood === 0) stampTextToGrid(grid, "z", sx + 6, sy - 2, "dim");
    }
  }

  return (seconds: number, theme?: AquariumTheme): string[] => {
    const fg = theme?.fg ? theme.fg.bind(theme) : (_token: ThemeToken, text: string) => text;

    // Episode selection with deterministic pseudo-random sequence
    const episodeIndex = Math.floor(seconds / EPISODE_DURATION);
    const episodeSec = seconds % EPISODE_DURATION;

    const curSceneIdx = Math.floor(pseudoNoise(episodeIndex, 42) * SCENES.length) % SCENES.length;
    const curScene = SCENES[curSceneIdx]!;

    const nextSceneIdx = Math.floor(pseudoNoise(episodeIndex + 1, 42) * (SCENES.length - 1));
    const nextCandidates = SCENES.filter((_, idx) => idx !== curSceneIdx);
    const nextScene = nextCandidates[nextSceneIdx % nextCandidates.length]!;

    // Base Grid Generator helper
    const makeGrid = (): Cell[][] => {
      const g: Cell[][] = Array.from({ length: rows }, () =>
        Array.from({ length: cols }, () => ({ char: " ", color: "text" as ThemeToken }))
      );

      // Borders
      g[0] = [
        { char: "┌", color: "dim" },
        ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
        { char: "┐", color: "dim" },
      ];
      g[rows - 1] = [
        { char: "└", color: "dim" },
        ...Array.from({ length: innerW }, () => ({ char: "─", color: "dim" as ThemeToken })),
        { char: "┘", color: "dim" },
      ];
      for (let r = 1; r < rows - 1; r++) {
        g[r]![0] = { char: "│", color: "dim" };
        g[r]![cols - 1] = { char: "│", color: "dim" };
      }

      // Clean, solid floor line (no flickering dots or rain effects)
      for (let c = 1; c < cols - 1; c++) {
        g[floor]![c] = { char: "─", color: "muted" };
      }

      return g;
    };

    function getSceneEndPos(scene: CatScene): number {
      const mid = Math.floor(cols / 2);
      switch (scene) {
        case "laser": return mid - 2;
        case "box": return cols >= 32 ? mid - 4 : cols - 10;
        case "ball": return Math.max(2, Math.min(cols - 12, mid - 4));
        case "treat": return Math.max(2, mid - 9);
        case "nap": return Math.max(2, mid - 8);
        case "scuffle": return Math.max(2, mid - 9);
      }
    }

    function getSceneStartPos(scene: CatScene): number {
      const mid = Math.floor(cols / 2);
      switch (scene) {
        case "laser": return Math.max(2, mid - 12);
        case "box": return cols >= 32 ? Math.max(2, mid - 10) : 3;
        case "ball": return Math.max(2, mid - 10);
        case "treat": return Math.max(2, mid - 11);
        case "nap": return Math.max(2, mid - 8);
        case "scuffle": return Math.max(2, mid - 9);
      }
    }

    function getKuroEndPos(scene: CatScene): number {
      const mid = Math.floor(cols / 2);
      switch (scene) {
        case "laser": return cols - 12;
        case "box": return cols >= 32 ? 3 : cols - 11;
        case "ball": return cols - 11;
        case "treat": return Math.min(cols - 11, mid + 3);
        case "nap": return cols - 12;
        case "scuffle": return Math.min(cols - 11, mid + 2);
      }
    }

    function getKuroStartPos(scene: CatScene): number {
      const mid = Math.floor(cols / 2);
      switch (scene) {
        case "laser": return cols - 12;
        case "box": return Math.max(2, mid - 10);
        case "ball": return cols - 11;
        case "treat": return Math.min(cols - 11, mid + 3);
        case "nap": return cols - 12;
        case "scuffle": return Math.min(cols - 11, mid + 2);
      }
    }

    let finalGrid = makeGrid();

    // Check if in transition window at end of episode: continuous walking morph (no rain/dither)
    const timeLeft = EPISODE_DURATION - episodeSec;
    if (timeLeft < TRANSITION_DURATION) {
      const p = 1.0 - (timeLeft / TRANSITION_DURATION); // 0.0 -> 1.0

      // Base props of upcoming scene fade in as cats walk over
      if (p > 0.4) {
        if (nextScene === "box") {
          const boxX = cols >= 32 ? Math.floor(cols / 2) - 4 : cols - 10;
          stampToGrid(finalGrid, SPRITES.boxEmpty, boxX, catY, "muted");
        } else if (nextScene === "ball") {
          finalGrid[floor - 1]![Math.floor(cols / 2)] = { char: "@", color: "accent" };
        } else if (nextScene === "laser") {
          finalGrid[floor - 1]![Math.floor(cols / 2)] = { char: "•", color: "error" };
        }
      }

      // Mochi walks from end position of curScene to start position of nextScene
      const mStartX = getSceneEndPos(curScene);
      const mEndX = getSceneStartPos(nextScene);
      const mCurX = Math.round(mStartX + (mEndX - mStartX) * p);
      const mFacingRight = mEndX >= mStartX;
      const mFrame = Math.floor(seconds * 4) % 3;
      const mSp = mFacingRight
        ? (mFrame === 0 ? SPRITES.mochiWalkR1 : mFrame === 1 ? SPRITES.mochiWalkR2 : SPRITES.mochiWalkR3)
        : (mFrame === 0 ? SPRITES.mochiWalkL1 : mFrame === 1 ? SPRITES.mochiWalkL2 : SPRITES.mochiWalkL3);
      stampToGrid(finalGrid, mSp, mCurX, catY, "text");

      // Kuro walks in wide terminals
      if (cols >= 32) {
        const kStartX = getKuroEndPos(curScene);
        const kEndX = getKuroStartPos(nextScene);
        const kCurX = Math.round(kStartX + (kEndX - kStartX) * p);
        const kFacingRight = kEndX >= kStartX;
        const kFrame = Math.floor(seconds * 3.5) % 3;
        const kSp = kFacingRight
          ? (kFrame === 0 ? SPRITES.kuroWalkR1 : kFrame === 1 ? SPRITES.kuroWalkR2 : SPRITES.kuroWalkR3)
          : (kFrame === 0 ? SPRITES.kuroWalkL1 : kFrame === 1 ? SPRITES.kuroWalkL2 : SPRITES.kuroWalkL3);
        stampToGrid(finalGrid, kSp, kCurX, catY, "dim");
      }

      // Pip on shelf stays calm and surveys
      if (rows >= 8 && cols >= 28) {
        const shelfW = 9;
        const sx = cols - shelfW - 2;
        const sy = 2;
        for (let i = 0; i < shelfW; i++) finalGrid[sy]![sx + i] = { char: "═", color: "dim" };
        finalGrid[sy]![sx] = { char: "╞", color: "dim" };
        finalGrid[sy]![sx + shelfW - 1] = { char: "╡", color: "dim" };
        stampToGrid(finalGrid, SPRITES.pipSit, sx + 2, sy - 2, "muted");
      }
    } else {
      renderSingleScene(finalGrid, curScene, episodeSec);
    }

    // Always render smooth celestial sky passer across row 1
    renderSkyPasser(finalGrid, cols, rows, seconds);

    return finalGrid.map(row => {
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
  };
}
