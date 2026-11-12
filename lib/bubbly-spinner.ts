import type { WorkingIndicatorOptions } from "@earendil-works/pi-coding-agent";

// ============================================================================
// Dictionaries
// ============================================================================

export const bigEnglishSpinnerVerbs: readonly string[] = [
  // Academic & Deep Thought
  "Ratiocinating",
  "Cerebrating",
  "Lucubrating",
  "Cogitating",
  "Excogitating",
  "Extemporizing",
  "Ruminating",
  "Philosophizing",
  "Syllogizing",
  "Contemplating",

  // Alchemy & Science
  "Crystallizing",
  "Amalgamating",
  "Transmuting",
  "Coalescing",
  "Sublimating",
  "Centrifuging",
  "Precipitating",
  "Synthesizing",
  "Distilling",
  "Concocting",

  // Engineering & Math
  "Reticulating",
  "Combobulating",
  "Discombobulating",
  "Concatenating",
  "Reconstituting",
  "Tessellating",
  "Interpolating",
  "Extrapolating",
  "Defenestrating",
  "Bifurcating",

  // Whimsical & Dramatic
  "Prestidigitating",
  "Perambulating",
  "Gallivanting",
  "Spelunking",
  "Bamboozling",
  "Pontificating",
  "Machinating",
  "ululating",
  "Finagling",
  "Shenaniganing",
];

export const memeAndMagicSpinners: readonly string[] = [
  // Magic & Wizardposting
  "Abracadabring",
  "Alakazaming",
  "Hocus-pocusing",
  "Bippity-boppity-booing",
  "Presto-changoing",
  "Skidaddling-skidoodling",
  "Open-sesaming",
  "Sim-sala-biming",
  "Shazaming",
  "Thaumaturging",
  "Conjuring",
  "Shadow-wizard-money-ganging",

  // Gen Z & Brainrot Memes
  "Mewing",
  "Looksmaxxing",
  "Mogging",
  "Rizzing",
  "Glazing",
  "Yapping",
  "Bussing",
  "Gaslighting",
  "Gatekeeping",
  "Girlbossing",
  "Aura-farming",
  "Brainrotting",

  // Dev & Gamer Memes
  "Vibe-coding",
  "Hallucinating",
  "Speedrunning",
  "Min-maxxing",
  "Theorycrafting",
  "Rawdogging",
  "Yoloing",
  "Coping",
  "Seething",
  "Malding",
  "Morbing",
  "Save-scumming",
  "Rage-quitting",
  "Rubber-ducking",
];

export const javaneseSpinnerVerbs: readonly string[] = [
  // Mikir & Ngrenung (Thinking & Contemplating)
  "Nggagas",
  "Nglamun",
  "Niteni",
  "Mikir",
  "Ngetung",
  "Nintingi",
  "Semedi",
  "Ngrasani",

  // Nyambut Gawe & Tumandang (Working & Action)
  "Nyambut gawe",
  "Tumandang",
  "Nggarap",
  "Ngulik",
  "Nyekrip",
  "Ngracik",
  "Nata",
  "Ngolah",

  // Whimsical & Guyonan (Playful Javanese)
  "Ngopi disik",
  "Golek wangsit",
  "Tapa brata",
  "Cangkrukan",
  "Jagongan",
  "Ngaso sedhela",
  "Ngronce tembung",
  "Ngudhar rasa",
];

/** Combined pool of all verbs across all categories rotated continuously. */
export const ALL_SPINNER_VERBS: readonly string[] = [
  ...bigEnglishSpinnerVerbs,
  ...memeAndMagicSpinners,
  ...javaneseSpinnerVerbs,
];

// ============================================================================
// Verb Rotator (shuffled cycle without back-to-back repeats)
// ============================================================================

export class VerbRotator {
  private readonly verbs: readonly string[];
  private pool: string[] = [];
  private index = 0;
  private lastYielded = "";

  constructor(verbs: readonly string[] = ALL_SPINNER_VERBS) {
    this.verbs = verbs;
    this.resetAndShuffle();
  }

  private resetAndShuffle(): void {
    this.pool = [...this.verbs];
    // Fisher-Yates shuffle
    for (let i = this.pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const temp = this.pool[i]!;
      this.pool[i] = this.pool[j]!;
      this.pool[j] = temp;
    }
    // Avoid repeating the last yielded verb across shuffle boundary
    if (this.pool.length > 1 && this.pool[0] === this.lastYielded) {
      const swapIndex = Math.floor(Math.random() * (this.pool.length - 1)) + 1;
      const temp = this.pool[0]!;
      this.pool[0] = this.pool[swapIndex]!;
      this.pool[swapIndex] = temp;
    }
    this.index = 0;
  }

  public nextVerb(): string {
    if (this.pool.length === 0) return "Working";
    if (this.index >= this.pool.length) {
      this.resetAndShuffle();
    }
    const verb = this.pool[this.index]!;
    this.index++;
    this.lastYielded = verb;
    return verb;
  }

  public get totalVerbs(): number {
    return this.verbs.length;
  }

  public get currentPosition(): number {
    return this.index;
  }
}

// ============================================================================
// Bubbly Animation Effect
// ============================================================================

const RESET_FG = "\x1b[39m";

function color(char: string, ansiFg: string): string {
  return `${ansiFg}${char}${RESET_FG}`;
}

function rgbToAnsiFg(rgb: RgbColor): string {
  return `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m`;
}

function rgbToCss(rgb: RgbColor): string {
  return `#${rgb.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

interface BubblyFrameSpec {
  char: string;
  rgb: RgbColor | null;
}

/**
 * Single-column Unicode bubble animation sequence.
 * Simulates a bubble rising, expanding, shimmering, and bursting,
 * rendered purely with Dracula purple, slightly purple, and white accents
 * (no rainbow). Each frame is guaranteed to be 1 display column wide to
 * prevent horizontal text jitter. The specs are the single source of truth:
 * `BUBBLY_FRAMES` is the ANSI form for the TUI, while `BUBBLY_FRAME_CHARS`
 * and `BUBBLY_FRAME_COLORS` carry the same sequence into the web.
 */
const BUBBLY_FRAME_SPECS: readonly BubblyFrameSpec[] = [
  { char: "·", rgb: [98, 114, 164] },   // tiny droplet (Dracula comment #6272a4)
  { char: "°", rgb: [148, 112, 200] },  // small bubble (Dracula slightly purple)
  { char: "∘", rgb: [148, 112, 200] },  // hollow ring (Dracula slightly purple)
  { char: "o", rgb: [189, 147, 249] },  // growing bubble (Dracula purple #bd93f9)
  { char: "O", rgb: [189, 147, 249] },  // expanding bubble (Dracula purple)
  { char: "○", rgb: [189, 147, 249] },  // hollow sphere (Dracula purple)
  { char: "◌", rgb: [148, 112, 200] },  // shimmering surface (Dracula slightly purple)
  { char: "◎", rgb: [248, 248, 242] },  // reflection (Dracula white #f8f8f2)
  { char: "●", rgb: [248, 248, 242] },  // gleaming core (Dracula white)
  { char: "◍", rgb: [189, 147, 249] },  // softening (Dracula purple)
  { char: "✧", rgb: [248, 248, 242] },  // *pop* sparkle! (Dracula white)
  { char: "✦", rgb: [148, 112, 200] },  // burst gleam (Dracula slightly purple)
  { char: "·", rgb: [98, 114, 164] },   // splash droplet (Dracula comment)
  { char: " ", rgb: null },             // micro-pause
];

export const BUBBLY_FRAME_CHARS: readonly string[] = BUBBLY_FRAME_SPECS.map((spec) => spec.char);
export const BUBBLY_FRAME_COLORS: readonly (string | null)[] = BUBBLY_FRAME_SPECS.map((spec) => (spec.rgb ? rgbToCss(spec.rgb) : null));
export const BUBBLY_FRAMES: readonly string[] = BUBBLY_FRAME_SPECS.map((spec) => (spec.rgb ? color(spec.char, rgbToAnsiFg(spec.rgb)) : spec.char));

export const BUBBLY_INTERVAL_MS = 95;

export const BUBBLY_INDICATOR_OPTIONS: WorkingIndicatorOptions = {
  frames: [...BUBBLY_FRAMES],
  intervalMs: BUBBLY_INTERVAL_MS,
};

// ============================================================================
// Bubbly Text Wave Effect (Bubbling -> bUbbling -> BuBbling -> ...)
// ============================================================================

/**
 * Applies a traveling bubble wave through a word:
 * Bubbling -> bUbbling -> BuBbling -> bUbBling -> BuBbLing ...
 * Non-alphabetic characters (spaces, hyphens) are preserved in place.
 */
export function applyBubbleCase(word: string, tick: number): string {
  const chars = word.split("");
  const letterIndices: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (/[a-zA-Z]/.test(chars[i]!)) {
      letterIndices.push(i);
    }
  }

  const numLetters = letterIndices.length;
  if (numLetters === 0) return word;

  const cycleLen = numLetters + 4;
  const t = ((tick % cycleLen) + cycleLen) % cycleLen;

  for (const idx of letterIndices) {
    chars[idx] = chars[idx]!.toLowerCase();
  }

  for (let pos = 0; pos < numLetters; pos++) {
    const diff = t - pos;
    // Spaced every 2 letters traveling forward, active window
    if (diff >= 0 && diff % 2 === 0 && diff <= 4) {
      const idx = letterIndices[pos]!;
      chars[idx] = chars[idx]!.toUpperCase();
    }
  }

  return chars.join("");
}

export class BubblyWordAnimator {
  private currentWord = "";
  private tick = 0;
  private wavePass = 0;
  private globalTick = 0;
  private readonly rotator: VerbRotator;

  /** Number of complete bubble wave passes before switching to next randomized word (~5s) */
  public static readonly WAVE_PASSES_PER_WORD = 3;
  /**
   * Slower gradient speed so the color gradation moves "late" (decoupled)
   * compared to the brisk letter bubble wave, making the gradation drift clearly visible.
   */
  public static readonly GRADIENT_SPEED = 0.012;

  constructor(rotator?: VerbRotator) {
    this.rotator = rotator ?? new VerbRotator();
    this.advanceWord();
  }

  public advanceWord(): string {
    this.currentWord = this.rotator.nextVerb();
    this.tick = 0;
    this.wavePass = 0;
    return this.getCurrentText();
  }

  public nextFrame(): string {
    const letterCount = this.currentWord.replace(/[^a-zA-Z]/g, "").length;
    const cycleLen = Math.max(1, letterCount + 4);

    this.globalTick++;
    this.tick++;

    if (this.tick >= cycleLen) {
      this.tick = 0;
      this.wavePass++;
      // Keep each word for multiple wave cycles so randomization is calm and not too fast
      if (this.wavePass >= BubblyWordAnimator.WAVE_PASSES_PER_WORD) {
        this.currentWord = this.rotator.nextVerb();
        this.wavePass = 0;
      }
    }
    return this.getCurrentText();
  }

  public getCurrentText(): string {
    return applyTrailingPurpleGradient(this.currentWord, this.tick);
  }

  public getRawCurrentText(): string {
    return `${applyBubbleCase(this.currentWord, this.tick)}...`;
  }

  public get word(): string {
    return this.currentWord;
  }

  public get currentTick(): number {
    return this.tick;
  }

  public get currentGlobalTick(): number {
    return this.globalTick;
  }

  public get currentWavePass(): number {
    return this.wavePass;
  }

  public get totalVerbs(): number {
    return this.rotator.totalVerbs;
  }
}

export const BUBBLY_TEXT_INTERVAL_MS = 120;

// ============================================================================
// Dracula Purple Trailing Color Wave (Pure Purple & Slightly Purple - No Rainbow)
// ============================================================================

export type RgbColor = readonly [number, number, number];

export const DRACULA_PURPLE: RgbColor = [189, 147, 249];        // #bd93f9 (Pure Dracula Purple)
export const DRACULA_SLIGHT_PURPLE: RgbColor = [148, 112, 200]; // Soft / Slightly Purple
export const DRACULA_BASE_MUTED: RgbColor = [98, 114, 164];     // #6272a4 (Dracula Comment / Muted Base)
export const DRACULA_WHITE: RgbColor = [248, 248, 242];          // #f8f8f2 (Dracula Foreground / White)
/** Halfway between slightly-purple and the muted base; the soft trailing fade. */
export const DRACULA_GENTLE_FADE: RgbColor = [
  Math.round((DRACULA_SLIGHT_PURPLE[0] + DRACULA_BASE_MUTED[0]) / 2),
  Math.round((DRACULA_SLIGHT_PURPLE[1] + DRACULA_BASE_MUTED[1]) / 2),
  Math.round((DRACULA_SLIGHT_PURPLE[2] + DRACULA_BASE_MUTED[2]) / 2),
];

function colorSegment(r: number, g: number, b: number, ch: string, bold: boolean = false): string {
  const bSeq = bold ? "\x1b[1m" : "";
  const rSeq = bold ? "\x1b[22m" : "";
  return `${bSeq}\x1b[38;2;${r};${g};${b}m${ch}\x1b[39m${rSeq}`;
}

export interface BubblyCharSegment {
  char: string;
  rgb: RgbColor;
  bold: boolean;
}

/** Per-character bubble-case wave with a trailing Dracula color walk. */
function bubblyCharSegments(word: string, tick: number): BubblyCharSegment[] {
  const chars = `${word}...`.split("");
  const letterIndices: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (/[a-zA-Z]/.test(chars[i]!)) letterIndices.push(i);
  }

  const numLetters = letterIndices.length;
  const cycleLen = Math.max(1, numLetters + 4);
  const t = ((tick % cycleLen) + cycleLen) % cycleLen;

  for (const idx of letterIndices) chars[idx] = chars[idx]!.toLowerCase();

  const isBubble: boolean[] = Array.from({ length: numLetters }, () => false);
  for (let pos = 0; pos < numLetters; pos++) {
    const diff = t - pos;
    if (diff >= 0 && diff % 2 === 0 && diff <= 4) {
      isBubble[pos] = true;
      chars[letterIndices[pos]!] = chars[letterIndices[pos]!]!.toUpperCase();
    }
  }

  return chars.map((char, i) => {
    const letterPos = letterIndices.indexOf(i);
    if (letterPos === -1) return { char, rgb: DRACULA_BASE_MUTED, bold: false };
    const distBehindLead = t - letterPos;
    if (distBehindLead === 0) return { char, rgb: DRACULA_WHITE, bold: true };
    if (distBehindLead === 1) return { char, rgb: DRACULA_PURPLE, bold: isBubble[letterPos]! };
    if (distBehindLead === 2) return { char, rgb: DRACULA_SLIGHT_PURPLE, bold: isBubble[letterPos]! };
    if (distBehindLead === 3) return { char, rgb: DRACULA_GENTLE_FADE, bold: isBubble[letterPos]! };
    return { char, rgb: DRACULA_BASE_MUTED, bold: isBubble[letterPos]! };
  });
}

/**
 * Applies the trailing purple color wave where the color walks behind the bubble text effect:
 * Crystalizing
 * cRystalizing   -> 'c' is purple (1 step behind bubble 'R')
 * CrYstalizing   -> 'C' is slightly purple, 'r' is purple (trailing behind 'Y')
 * Rest of inactive letters rest in muted Dracula comment (#6272a4).
 * Pure purple and slightly purple tones without rainbow.
 */
export function applyTrailingPurpleGradient(word: string, tick: number): string {
  if (!/[a-zA-Z]/.test(word)) return `${word}...`;
  return bubblyCharSegments(word, tick)
    .map((segment) => colorSegment(segment.rgb[0], segment.rgb[1], segment.rgb[2], segment.char, segment.bold))
    .join("");
}

/** The same gradient as colored segments for the web working line. */
export interface BubblyMessageSegment { text: string; color: string; bold: boolean }

export function bubblyMessageSegments(word: string, tick: number): BubblyMessageSegment[] {
  return bubblyCharSegments(word, tick).map((segment) => ({
    text: segment.char,
    color: rgbToCss(segment.rgb),
    bold: segment.bold,
  }));
}


