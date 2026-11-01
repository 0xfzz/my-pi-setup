import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
  AnimationRegistry,
  SidebarAnimationPlayer,
  animationHeight,
  aquariumPiece,
  matrixPiece,
  campfirePiece,
  catsPiece,
  randomPiece,
  type AsciiAnimationPiece,
} from "../lib/sidebar/sidebar-animation.ts";

test("animation registry registers, selects, lists, and falls back safely", () => {
  const registry = new AnimationRegistry();
  assert.equal(registry.current.id, "aquarium");
  const list = registry.list();
  assert.ok(list.some(p => p.id === "aquarium"));
  assert.ok(list.some(p => p.id === "matrix"));
  assert.ok(list.some(p => p.id === "fire"));
  assert.ok(list.some(p => p.id === "cats"));
  assert.ok(list.some(p => p.id === "auto"));

  assert.equal(registry.select("matrix"), true);
  assert.equal(registry.current.id, "matrix");
  assert.equal(registry.current.name, "Matrix Rain");

  assert.equal(registry.select("fire"), true);
  assert.equal(registry.current.id, "fire");

  assert.equal(registry.select("cats"), true);
  assert.equal(registry.current.id, "cats");
  assert.equal(registry.current.name, "Cat Arena");

  assert.equal(registry.select("cat"), true);
  assert.equal(registry.current.id, "cats");

  assert.equal(registry.select("auto"), true);
  assert.equal(registry.current.id, "auto");
  assert.equal(registry.current.name, "Auto Gallery");

  assert.equal(registry.select("random"), true);
  assert.equal(registry.current.id, "auto");

  assert.equal(registry.select("shuffle"), true);
  assert.equal(registry.current.id, "auto");

  assert.equal(registry.select("nonexistent"), false);
  assert.equal(registry.current.id, "auto");

  const customPiece: AsciiAnimationPiece = {
    id: "clock",
    name: "Digital Clock",
    render: (cols, rows) => Array.from({ length: rows }, () => " ".repeat(cols)),
  };
  registry.register(customPiece);
  assert.equal(registry.select("clock"), true);
  assert.equal(registry.current.name, "Digital Clock");

  registry.unregister("clock");
  assert.equal(registry.current.id, "aquarium");
});

test("all built-in pieces render valid dimensions, box borders, and theme tokens", () => {
  const mockTheme = {
    fg: (token: string, text: string) => `\x1b[36m${text}\x1b[0m`,
  };

  for (const piece of [aquariumPiece, matrixPiece, campfirePiece, catsPiece, randomPiece]) {
    for (const width of [18, 22, 30, 44]) {
      for (const height of [6, 8, 10]) {
        for (const sec of [1.5, 27.5]) {
          const frame = piece.render(width, height, sec, mockTheme as any);
          assert.equal(frame.length, height, `${piece.id} height`);
          assert.ok(
            frame.every(line => visibleWidth(line) === width),
            `${piece.id} ${width}x${height} visible width`
          );
          assert.ok(frame[0]!.includes("┌") && frame[0]!.includes("┐"));
          assert.ok(frame.at(-1)!.includes("└") && frame.at(-1)!.includes("┘"));
        }
      }
    }
  }
});

test("animation player synchronizes clock with active piece fps and disposes cleanly", t => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const registry = new AnimationRegistry();
  let visible = true;
  let redraws = 0;
  const player = new SidebarAnimationPlayer(registry, () => visible, () => redraws++);

  player.sync();
  t.mock.timers.tick(1000 / 15 * 3 + 1);
  assert.equal(redraws, 3);

  // Switch to matrix piece (fps = 12)
  registry.select("matrix");
  player.sync();
  const mark = redraws;
  t.mock.timers.tick(1000 / 12 * 2 + 1);
  assert.equal(redraws, mark + 2);

  visible = false;
  t.mock.timers.tick(500);
  assert.equal(redraws, mark + 2);

  player.dispose();
  t.mock.timers.tick(1000);
  assert.equal(redraws, mark + 2);
});

test("animation height bounds adhere to minimum and maximum constraints", () => {
  assert.equal(animationHeight(24, 10), 10);
  assert.equal(animationHeight(24, 14), 8);
  assert.equal(animationHeight(20, 12), 6);
  assert.equal(animationHeight(19, 12), 0);
  assert.equal(animationHeight(8, 14), 0);
});

test("animation registry persists last picked ascii art and restores as default", () => {
  const tmpFile = path.join(os.tmpdir(), `test-anim-persist-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
  try {
    const reg1 = new AnimationRegistry({ persistencePath: tmpFile });
    assert.equal(reg1.current.id, "aquarium");

    // Select cats: should persist to file
    assert.equal(reg1.select("cats"), true);
    assert.equal(reg1.current.id, "cats");

    // Create a new registry with autoRestore: should restore cats as default
    const reg2 = new AnimationRegistry({ persistencePath: tmpFile, autoRestore: true });
    assert.equal(reg2.current.id, "cats");

    // Select fire via alias campfire
    assert.equal(reg2.select("campfire"), true);
    assert.equal(reg2.current.id, "fire");

    // Create third registry: should restore fire as default
    const reg3 = new AnimationRegistry({ persistencePath: tmpFile, autoRestore: true });
    assert.equal(reg3.current.id, "fire");
  } finally {
    try { if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile); } catch {}
  }
});

test("cat arena piece has active idle animation with sky passers and zero freezes", () => {
  const registry = new AnimationRegistry();
  const cats = registry.get("cats");
  assert.ok(cats, "cats piece must exist");

  const frame1 = cats.render(36, 8, 10.0);
  const frame2 = cats.render(36, 8, 10.5);
  const frame3 = cats.render(36, 8, 11.0);

  // Cats and sky should be actively animated across seconds
  assert.notEqual(frame1.join("\n"), frame2.join("\n"), "frames must not freeze");
  assert.notEqual(frame2.join("\n"), frame3.join("\n"), "frames must continuously animate");

  // Sky passers should appear on row 1 across celestial cycles
  const ufoFrame = cats.render(36, 8, 6.0)[1]!;
  assert.ok(ufoFrame.includes("<(o)>"), "UFO should cruise across row 1");

  const satFrame = cats.render(36, 8, 32.0)[1]!;
  assert.ok(satFrame.includes("|=o=|"), "Satellite should orbit across row 1");
});
