import assert from "node:assert/strict";
import test from "node:test";

import {
  createThumbnailer, DEFAULT_THUMBNAIL_CONFIG, patchImageRender, SMALL_IMAGE_BASE64_CHARS,
  validateThumbnailConfig, type PatchableImage, type Thumbnail, type ThumbnailConfig,
} from "../lib/image-thumbnails.ts";

const BIG = "A".repeat(SMALL_IMAGE_BASE64_CHARS + 5_000);
const THUMB: Thumbnail = { data: "tiny", mimeType: "image/jpeg" };
const tick = () => new Promise((resolve) => setImmediate(resolve));

/** Stand-in for pi-tui's Image: render() reports what it would send to the terminal. */
class FakeImage implements PatchableImage {
  pngData?: string;
  theme = { fallbackColor: (text: string) => text };
  invalidated = 0;
  base64Data: string;
  mimeType: string;
  constructor(base64Data: string, mimeType = "image/png") {
    this.base64Data = base64Data;
    this.mimeType = mimeType;
  }
  invalidate() { this.invalidated++; }
  render(): string[] { return [`sent:${this.mimeType}:${this.base64Data.length}`]; }
}

function setup(overrides: { resize?: () => Promise<Thumbnail | null>; config?: Partial<ThumbnailConfig>; draw?: boolean; kitty?: boolean } = {}) {
  let calls = 0;
  let ready = 0;
  const config = { ...DEFAULT_THUMBNAIL_CONFIG, ...overrides.config };
  const thumbnailer = createThumbnailer({
    async resize() { calls++; return overrides.resize ? overrides.resize() : THUMB; },
    async toPng(thumb) { return { data: `png-${thumb.data}`, mimeType: "image/png" }; },
    needsPng: () => overrides.kitty === true,
  }, () => config);
  class Patched extends FakeImage {}
  const restore = patchImageRender(Patched.prototype, {
    thumbnailer, getConfig: () => config, canDrawImages: () => overrides.draw !== false, onReady: () => { ready++; },
  });
  return { Patched, restore, calls: () => calls, ready: () => ready };
}

test("a large image shows a placeholder, then the thumbnail, and never the original payload", async () => {
  const { Patched, ready } = setup();
  const image = new Patched(BIG);
  assert.match(image.render()[0]!, /preparing preview/);
  await tick();
  assert.equal(ready(), 1, "the host is asked to repaint");
  assert.deepEqual(image.render(), ["sent:image/jpeg:4"]);
});

test("the caller's data is never modified", async () => {
  const { Patched } = setup();
  const attachment = { data: BIG, mimeType: "image/png" };
  const image = new Patched(attachment.data, attachment.mimeType);
  image.render();
  await tick();
  image.render();
  assert.equal(attachment.data, BIG);
  assert.equal(attachment.data.length, SMALL_IMAGE_BASE64_CHARS + 5_000);
});

test("small images are shown as they are, without any resizing", async () => {
  const { Patched, calls } = setup();
  const image = new Patched("A".repeat(1000));
  assert.equal(image.render()[0], "sent:image/png:1000");
  await tick();
  assert.equal(calls(), 0);
});

test("a decode failure falls back to the original", async () => {
  const { Patched } = setup({ resize: async () => null });
  const image = new Patched(BIG);
  image.render();
  await tick();
  assert.equal(image.render()[0], `sent:image/png:${BIG.length}`);
});

test("a thumbnail that is not smaller than the original is not used", async () => {
  const { Patched } = setup({ resize: async () => ({ data: BIG + "x", mimeType: "image/jpeg" }) });
  const image = new Patched(BIG);
  image.render();
  await tick();
  assert.equal(image.render()[0], `sent:image/png:${BIG.length}`);
});

test("the same image is resized once and a second instance shows it without a placeholder", async () => {
  const { Patched, calls } = setup();
  const first = new Patched(BIG);
  first.render();
  await tick();
  const second = new Patched(BIG);
  assert.equal(second.render()[0], "sent:image/jpeg:4", "no placeholder frame for a cached image");
  assert.equal(calls(), 1);
});

test("Kitty terminals get a PNG thumbnail", async () => {
  const { Patched } = setup({ kitty: true });
  const image = new Patched(BIG);
  image.render();
  await tick();
  assert.equal(image.render()[0], "sent:image/png:8");
});

test("disabled, or a terminal that cannot draw images, is a passthrough", async () => {
  for (const options of [{ config: { enabled: false } }, { draw: false }]) {
    const { Patched, calls } = setup(options);
    const image = new Patched(BIG);
    assert.equal(image.render()[0], `sent:image/png:${BIG.length}`);
    await tick();
    assert.equal(calls(), 0);
  }
});

test("restore puts the original render back, and patching twice does not stack wrappers", () => {
  class Img extends FakeImage {}
  const baseline = Img.prototype.render;
  const options = {
    thumbnailer: createThumbnailer({ resize: async () => THUMB, needsPng: () => false }, () => DEFAULT_THUMBNAIL_CONFIG),
    getConfig: () => DEFAULT_THUMBNAIL_CONFIG, canDrawImages: () => true, onReady: () => {},
  };
  patchImageRender(Img.prototype, options);
  const restore = patchImageRender(Img.prototype, options);
  restore();
  assert.equal(Img.prototype.render, baseline);
});

test("config validation", () => {
  assert.equal(validateThumbnailConfig({}).maxDimension, 640);
  assert.equal(validateThumbnailConfig({ maxDimension: 320, enabled: false }).enabled, false);
  assert.throws(() => validateThumbnailConfig({ nope: 1 }), /Unknown/);
  assert.throws(() => validateThumbnailConfig({ jpegQuality: 101 }), /at most 100/);
  assert.throws(() => validateThumbnailConfig({ enabled: "yes" }), /enabled/);
});
