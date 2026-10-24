import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import bubblySpinnerExtension from "../extensions/bubbly-spinner.ts";
import {
  ALL_SPINNER_VERBS,
  BUBBLY_FRAMES,
  BUBBLY_INDICATOR_OPTIONS,
  BUBBLY_TEXT_INTERVAL_MS,
  BubblyWordAnimator,
  applyBubbleCase,
  applyTrailingPurpleGradient,
  DRACULA_PURPLE,
  DRACULA_SLIGHT_PURPLE,
  DRACULA_BASE_MUTED,
  DRACULA_WHITE,
  VerbRotator,
  bigEnglishSpinnerVerbs,
  javaneseSpinnerVerbs,
  memeAndMagicSpinners,
} from "../lib/bubbly-spinner.ts";

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

test("trailing purple color wave matches exact user sequence without rainbow", () => {
  const word = "Crystalizing";

  // t = 0: "Crystalizing..." (C is leading bubble: bold white)
  const t0 = applyTrailingPurpleGradient(word, 0);
  assert.equal(stripAnsi(t0), "Crystalizing...");
  assert.equal(visibleWidth(t0), "Crystalizing...".length);
  assert.ok(t0.includes("\x1b[1m\x1b[38;2;248;248;242mC\x1b[39m\x1b[22m"));

  // t = 1: "cRystalizing..." ('R' is leading bubble; 'c' is 1 step behind = Dracula Purple #bd93f9)
  const t1 = applyTrailingPurpleGradient(word, 1);
  assert.equal(stripAnsi(t1), "cRystalizing...");
  assert.ok(t1.includes("\x1b[38;2;189;147;249mc\x1b[39m")); // c is purple!
  assert.ok(t1.includes("\x1b[1m\x1b[38;2;248;248;242mR\x1b[39m\x1b[22m")); // R is white

  // t = 2: "CrYstalizing..." ('Y' is lead; 'r' is purple; 'C' is 2 steps behind = Slightly Purple)
  const t2 = applyTrailingPurpleGradient(word, 2);
  assert.equal(stripAnsi(t2), "CrYstalizing...");
  assert.ok(t2.includes("\x1b[1m\x1b[38;2;148;112;200mC\x1b[39m\x1b[22m")); // C is slightly purple!
  assert.ok(t2.includes("\x1b[38;2;189;147;249mr\x1b[39m")); // r is purple!
  assert.ok(t2.includes("\x1b[1m\x1b[38;2;248;248;242mY\x1b[39m\x1b[22m")); // Y is white

  // Color walks behind the bubble across all frames with no rainbow hues
  assert.ok(!t1.includes("255;121;198")); // No pink
  assert.ok(!t1.includes("139;233;253")); // No cyan
  assert.ok(!t2.includes("255;121;198")); // No pink
  assert.ok(!t2.includes("139;233;253")); // No cyan
});

test("applyBubbleCase produces exact user pattern Bubbling -> bUbbling -> BuBbling", () => {
  assert.equal(applyBubbleCase("Bubbling", 0), "Bubbling");
  assert.equal(applyBubbleCase("Bubbling", 1), "bUbbling");
  assert.equal(applyBubbleCase("Bubbling", 2), "BuBbling");
  assert.equal(applyBubbleCase("Bubbling", 3), "bUbBling");
  assert.equal(applyBubbleCase("Bubbling", 4), "BuBbLing");
  assert.equal(applyBubbleCase("Bubbling", 5), "bUbBlIng");
  assert.equal(applyBubbleCase("Bubbling", 6), "buBbLiNg");
  assert.equal(applyBubbleCase("Bubbling", 7), "bubBlInG");

  // Spaces and hyphens are preserved in place
  assert.equal(applyBubbleCase("Nyambut gawe", 0), "Nyambut gawe");
  assert.equal(applyBubbleCase("Nyambut gawe", 1), "nYambut gawe");
  assert.equal(applyBubbleCase("Nyambut gawe", 2), "NyAmbut gawe");
  assert.ok(applyBubbleCase("Vibe-coding", 3).includes("-"));
});

test("BubblyWordAnimator retains words across 3 wave passes before randomizing", () => {
  const rotator = new VerbRotator(["Bubbling", "Testing"]);
  const animator = new BubblyWordAnimator(rotator);

  assert.ok(stripAnsi(animator.getCurrentText()).endsWith("..."));
  assert.ok(animator.getRawCurrentText().endsWith("..."));
  const firstWord = animator.word;

  // For "Bubbling" (8 letters), cycleLen is 12 (8 letters + 4 pause ticks)
  const cycleLen = 8 + 4;

  // Pass 1: complete one full wave pass
  for (let i = 0; i < cycleLen; i++) {
    animator.nextFrame();
  }
  // Word must NOT randomize yet (it stays for 3 passes)
  assert.equal(animator.word, firstWord);
  assert.equal(animator.currentWavePass, 1);

  // Pass 2: complete second wave pass
  for (let i = 0; i < cycleLen; i++) {
    animator.nextFrame();
  }
  assert.equal(animator.word, firstWord);
  assert.equal(animator.currentWavePass, 2);

  // Pass 3: complete third wave pass -> transitions to next randomized word!
  for (let i = 0; i < cycleLen; i++) {
    animator.nextFrame();
  }
  assert.notEqual(animator.word, firstWord);
  assert.equal(animator.currentWavePass, 0);
});

test("dictionaries are well-formed and populated", () => {
  assert.equal(bigEnglishSpinnerVerbs.length, 40);
  assert.equal(memeAndMagicSpinners.length, 38);
  assert.ok(javaneseSpinnerVerbs.length >= 20);

  // Big English specific checks
  assert.ok(bigEnglishSpinnerVerbs.includes("Ratiocinating"));
  assert.ok(bigEnglishSpinnerVerbs.includes("Combobulating"));
  assert.ok(bigEnglishSpinnerVerbs.includes("Prestidigitating"));

  // Meme & Magic checks
  assert.ok(memeAndMagicSpinners.includes("Abracadabring"));
  assert.ok(memeAndMagicSpinners.includes("Vibe-coding"));
  assert.ok(memeAndMagicSpinners.includes("Mewing"));

  // Javanese checks
  assert.ok(javaneseSpinnerVerbs.includes("Nyambut gawe"));
  assert.ok(javaneseSpinnerVerbs.includes("Tumandang"));
  assert.ok(javaneseSpinnerVerbs.includes("Mikir"));

  // Combined pool contains all
  const expectedTotal =
    bigEnglishSpinnerVerbs.length +
    memeAndMagicSpinners.length +
    javaneseSpinnerVerbs.length;
  assert.equal(ALL_SPINNER_VERBS.length, expectedTotal);
});

test("BUBBLY_FRAMES are all 1 column wide to prevent terminal jitter", () => {
  assert.ok(BUBBLY_FRAMES.length >= 8);
  assert.equal(BUBBLY_INDICATOR_OPTIONS.intervalMs, 95);
  assert.equal(BUBBLY_INDICATOR_OPTIONS.frames?.length, BUBBLY_FRAMES.length);

  for (const frame of BUBBLY_FRAMES) {
    const width = visibleWidth(frame);
    // Every frame must be exactly 1 cell wide (or 1 for space/char)
    assert.equal(width, 1, `Frame "${frame}" should have visible width 1 but got ${width}`);
  }
});

test("VerbRotator cycles through verbs without immediate duplicates", () => {
  const rotator = new VerbRotator();
  assert.equal(rotator.totalVerbs, ALL_SPINNER_VERBS.length);

  const seen = new Set<string>();
  let previous = "";

  // Run through two full cycles of the entire pool
  const iterations = rotator.totalVerbs * 2;
  for (let i = 0; i < iterations; i++) {
    const verb = rotator.nextVerb();
    assert.ok(verb && verb.length > 0, "Verb must not be empty");
    assert.ok(ALL_SPINNER_VERBS.includes(verb), `Verb "${verb}" must be in the pool`);
    assert.notEqual(
      verb,
      previous,
      `Consecutive verbs should not be identical: "${verb}" == "${previous}" at index ${i}`
    );
    seen.add(verb);
    previous = verb;
  }

  // Over two full cycles, every verb in the pool should have been seen
  assert.equal(seen.size, ALL_SPINNER_VERBS.length);
});

test("bubblySpinnerExtension registers hooks and manages working indicator/message", async () => {
  const events = new Map<string, (event: any, ctx: any) => Promise<void> | void>();
  const commands = new Map<string, any>();

  const messages: string[] = [];
  let indicatorSet: any = null;
  const notifications: string[] = [];

  const fakeUi = {
    setWorkingIndicator: (indicator: any) => {
      indicatorSet = indicator;
    },
    setWorkingMessage: (msg: string) => {
      messages.push(msg);
    },
    notify: (msg: string) => {
      notifications.push(msg);
    },
  };

  const fakeCtx = {
    ui: fakeUi,
  };

  const fakePi: any = {
    on: (event: string, handler: any) => {
      events.set(event, handler);
      return () => events.delete(event);
    },
    registerCommand: (name: string, def: any) => {
      commands.set(name, def);
    },
  };

  bubblySpinnerExtension(fakePi);

  // Check registered hooks
  assert.ok(events.has("session_start"));
  assert.ok(events.has("agent_start"));
  assert.ok(events.has("turn_start"));
  assert.ok(events.has("agent_end"));
  assert.ok(events.has("session_shutdown"));
  assert.ok(commands.has("bubbly"));

  // Test session_start
  await events.get("session_start")!({}, fakeCtx);
  assert.equal(indicatorSet, BUBBLY_INDICATOR_OPTIONS);
  assert.equal(messages.length, 1);
  assert.ok(stripAnsi(messages[0]!).endsWith("..."));

  // Test agent_start
  await events.get("agent_start")!({}, fakeCtx);
  assert.equal(messages.length, 2);
  assert.ok(stripAnsi(messages[1]!).endsWith("..."));

  // Test turn_start
  await events.get("turn_start")!({}, fakeCtx);
  assert.equal(messages.length, 3);
  assert.ok(stripAnsi(messages[2]!).endsWith("..."));

  // Test agent_end
  await events.get("agent_end")!({}, fakeCtx);
  assert.equal(messages.length, 4);

  // Test /bubbly command
  const cmd = commands.get("bubbly");
  await cmd.handler("", fakeCtx);
  assert.ok(notifications.length > 0);
  assert.ok(notifications[0]!.includes("Bubbly Spinner Active"));

  await cmd.handler("next", fakeCtx);
  assert.equal(messages.length, 5);
  assert.ok(notifications.some((n) => n.includes("Advanced to next bubbly verb")));

  // Test session_shutdown cleans up
  await events.get("session_shutdown")!({}, fakeCtx);
});
