import test from "node:test";
import assert from "node:assert/strict";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AQUARIUM_FPS,
  AquariumAnimation,
  aquariumHeight,
  createAquarium,
  AquariumSimulation,
  clearAquariumFood,
  getAquariumSimulation,
} from "../../lib/sidebar/sidebar-aquarium.ts";

test("aquarium frames keep complete borders and exact terminal dimensions at every sidebar size", () => {
  for (const width of [12, 18, 20, 22, 30, 36, 44, 58, 60, 120]) {
    for (const height of [6, 7, 8, 9, 10, 20, 30]) {
      const scene = createAquarium(width, height);
      for (const time of [0, 1 / 15, 0.5, 1, 7, 12, 23, 47.99, 48, -1]) {
        const frame = scene(time);
        assert.equal(frame.length, height);
        assert.ok(frame.every(line => visibleWidth(line) === width), `${width}x${height} at ${time}`);
        assert.equal(frame[0], `┌${"─".repeat(width - 2)}┐`);
        assert.equal(frame.at(-1), `└${"─".repeat(width - 2)}┘`);
        assert.ok(frame.slice(1, -1).every(line => line.startsWith("│") && line.endsWith("│")));
        // oxlint-disable-next-line no-control-regex
        assert.ok(frame.every(line => !/[\x00-\x1f\x7f-\x9f]/.test(line)));
      }
    }
  }
});

test("adapted upstream aquarium swims, loops, and renders offline with preserved internal spaces", () => {
  const scene = createAquarium(22, 10);
  const initial = scene(0);
  assert.notDeepEqual(initial, scene(1));
  assert.deepEqual(initial, scene(48));
  assert.deepEqual(scene(-1), scene(47));
  assert.match(initial.join("\n"), /[<>°]/);
  assert.match(initial.join("\n"), / {2}/);
  assert.match(initial[1]!, /[~-]+/);
  assert.throws(() => createAquarium(10, 8), RangeError);
  assert.throws(() => createAquarium(22, 5), RangeError);
  assert.throws(() => createAquarium(22.5, 8), RangeError);
  assert.throws(() => createAquarium(121, 8), RangeError);
});

test("aquarium supports theme styling and scales creature biodiversity with width", () => {
  const tokensUsed = new Set<string>();
  const mockTheme = {
    fg(token: string, text: string) {
      tokensUsed.add(token);
      return text;
    },
  };
  const small = createAquarium(22, 8)(0, mockTheme as any);
  assert.ok(tokensUsed.has("accent")); // neon tetra body, bubbles, water ripples
  assert.ok(tokensUsed.has("success")); // green kelp
  assert.ok(tokensUsed.has("error")); // red tailfin on neon tetra
  assert.ok(tokensUsed.has("dim")); // glass border and sand
  assert.ok(small.every(line => visibleWidth(line) === 22));

  tokensUsed.clear();
  const wide = createAquarium(44, 10)(0, mockTheme as any);
  assert.ok(tokensUsed.has("accent")); // tetra, bubbles, jelly
  assert.ok(tokensUsed.has("warning")); // angelfish / minnow
  assert.ok(tokensUsed.has("error")); // crab & red tailfin
  assert.ok(tokensUsed.has("success")); // kelp stalks
  assert.ok(wide.every(line => visibleWidth(line) === 44));
});

test("aquarium uses only spare rows and hides instead of displacing sidebar sections", () => {
  assert.equal(aquariumHeight(24, 10), 10);
  assert.equal(aquariumHeight(24, 14), 8);
  assert.equal(aquariumHeight(20, 12), 6);
  assert.equal(aquariumHeight(19, 12), 0);
  assert.equal(aquariumHeight(8, 14), 0);
  assert.equal(aquariumHeight(100, 0), 10);
});

test("one animation clock pauses hidden frames, resumes, and cannot restart after disposal", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let visible = false, redraws = 0;
  const animation = new AquariumAnimation(() => visible, () => redraws++);
  const initial = animation.render(22, 10);
  animation.sync();
  t.mock.timers.tick(200);
  assert.equal(redraws, 0);
  visible = true;
  animation.sync(); animation.sync(); animation.sync();
  t.mock.timers.tick(1000 / AQUARIUM_FPS * 3 + 1);
  assert.equal(redraws, 3);
  assert.notDeepEqual(animation.render(22, 10), initial);
  assert.equal(animation.render(30, 8)[0]!.length, 30);
  visible = false;
  t.mock.timers.tick(200);
  assert.equal(redraws, 3);
  const paused = animation.render(22, 10);
  t.mock.timers.tick(2000);
  assert.deepEqual(animation.render(22, 10), paused);
  visible = true;
  animation.sync();
  t.mock.timers.tick(200);
  assert.ok(redraws > 3);
  animation.dispose(); animation.dispose();
  const before = redraws;
  animation.sync();
  t.mock.timers.tick(2000);
  assert.equal(redraws, before);
});

test("biota wander randomly in 2D space across both horizontal and vertical depth", () => {
  const scene = createAquarium(40, 10);
  const rowsObserved = new Set<number>();
  const colsObserved = new Set<number>();

  for (let t = 0; t < 30; t += 1.5) {
    const frame = scene(t);
    // Find Neon Tetra tail '><' or body '(((' in rows 2 to 7
    for (let r = 2; r <= 7; r++) {
      const idx = frame[r]!.indexOf("(((");
      if (idx !== -1) {
        rowsObserved.add(r);
        colsObserved.add(idx);
      }
    }
  }

  // Neon Tetra wanders vertically across multiple rows and horizontally across columns
  assert.ok(rowsObserved.size >= 3, `Expected at least 3 distinct vertical depths, got ${rowsObserved.size}`);
  assert.ok(colsObserved.size >= 5, `Expected at least 5 distinct horizontal positions, got ${colsObserved.size}`);
});

test("food dropped at top position falls with gravity down toward the gravel floor", () => {
  clearAquariumFood();
  const sim = new AquariumSimulation(30, 10);
  const food = sim.dropFood(15);

  assert.equal(food.x, 15);
  assert.equal(food.y, 1.0); // Starts at top water surface
  assert.equal(food.settled, false);
  assert.equal(food.eaten, false);

  const initialY = food.y;
  // Step simulation forward 1 second (15 frames)
  sim.update(1.0);
  assert.ok(food.y > initialY, `Expected food to fall downward, got y=${food.y} (initial=${initialY})`);

  const midY = food.y;
  const initialVy = food.vy;
  // Step forward another 1 second
  sim.update(2.0);
  assert.ok(food.y > midY, "Food continues accelerating downward");
  assert.ok(food.vy >= initialVy, "Gravity accelerates downward velocity");

  // Step forward until food reaches the gravel floor (floor = 10 - 2 = 8)
  for (let s = 3.0; s <= 8.0; s += 0.5) {
    sim.update(s);
  }
  assert.equal(food.settled, true);
  assert.equal(food.y, 8); // Settled on gravel bed
});

test("hungry biota detect food, swim toward it, eat it, reset hunger, and become happy", () => {
  clearAquariumFood();
  const sim = new AquariumSimulation(30, 10);
  sim.setHunger("tetra", 0.9); // Starving tetra
  assert.ok(sim.getHunger("tetra") >= 0.7);

  // Drop food near the tetra's swimming path
  const food = sim.dropFood(12);
  const scene = createAquarium(30, 10, sim);

  // Render before eating: hungry eye 'O' or 'o' should be visible
  const beforeFrame = scene(0.5);
  assert.match(beforeFrame.join("\n"), /[oO]/, "Hungry fish exhibits hungry eye expression");

  // Advance simulation so tetra intercepts and eats the food
  let eaten = false;
  for (let t = 1.0; t <= 5.0; t += 0.2) {
    scene(t);
    if (food.eaten) {
      eaten = true;
      break;
    }
  }
  assert.ok(eaten, "Hungry tetra intercepted and consumed the falling food");
  assert.equal(sim.getHunger("tetra"), 0, "Tetra hunger reset to 0 after eating");

  // During happy eating state, eye changes to happy '^'
  const happyFrame = scene(sim.lastSeconds ?? 2.0);
  assert.match(happyFrame.join("\n"), /\^/, "Fish exhibits happy eyes '^' after feeding");
});

test("crab on gravel bed detects settled food and eats it with snapping claws", () => {
  clearAquariumFood();
  const sim = new AquariumSimulation(36, 10);
  sim.setHunger("crab", 0.8);
  const food = sim.dropFood(16);

  // Let food sink all the way to the gravel floor (y = 8)
  for (let s = 0.5; s <= 6.0; s += 0.5) {
    sim.update(s);
  }
  assert.equal(food.settled, true);

  // Render scene: hungry crab scuttles toward settled food on gravel
  const scene = createAquarium(36, 10, sim);
  let crabAte = false;
  for (let s = 6.5; s <= 12.0; s += 0.5) {
    scene(s);
    if (food.eaten) {
      crabAte = true;
      break;
    }
  }
  assert.ok(crabAte, "Crab found and ate the food on the gravel bed");
  assert.equal(sim.getHunger("crab"), 0, "Crab hunger reset after eating");
});

test("mouse click or handleMouse on top position of fish tank feeds the tank", () => {
  clearAquariumFood();
  const anim = new AquariumAnimation(() => true, () => {});
  anim.render(30, 10);

  // Clicking top position: row 0 (top glass border) or row 1 (water surface)
  const result = anim.handleMouse({ x: 14, y: 0 }, { x: 2, y: 0, width: 30, height: 10 });
  assert.deepEqual(result, { handled: true, render: true });

  const sim = getAquariumSimulation(30, 10);
  assert.ok(sim.hasActiveFoods(), "Active food particle was created on top click");
  const food = sim.foods[0]!;
  assert.equal(food.x, 12); // 14 - bounds.x (2) = 12
  assert.equal(food.y, 1.0); // Surface row
});

