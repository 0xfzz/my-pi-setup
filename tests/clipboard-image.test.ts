import assert from "node:assert/strict";
import { test } from "node:test";
import { looksLikeText, readClipboard, sniffImage } from "../lib/clipboard.ts";

/** Minimal byte sequences with the real magic numbers. */
const PNG = Buffer.concat([Buffer.from([0x89]), Buffer.from("PNG\r\n\x1a\n"), Buffer.from("rest-of-image")]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jfif")]);
const GIF = Buffer.from("GIF89a-body");
const WEBP = Buffer.concat([Buffer.from("RIFF"), Buffer.from([0x20, 0, 0, 0]), Buffer.from("WEBPVP8 ")]);

function harness(respond: (command: string, args: string[]) => Buffer | undefined) {
  const calls: string[][] = [];
  return {
    calls,
    read: () => readClipboard({
      run: async (command, args) => {
        calls.push([command, ...args]);
        return respond(command, args);
      },
      env: { WAYLAND_DISPLAY: "wayland-0" },
      exists: () => false,
      readdir: () => [],
      platform: "linux",
    }),
  };
}

test("images are recognised by magic number", () => {
  assert.equal(sniffImage(PNG), "image/png");
  assert.equal(sniffImage(JPEG), "image/jpeg");
  assert.equal(sniffImage(GIF), "image/gif");
  assert.equal(sniffImage(WEBP), "image/webp");
  assert.equal(sniffImage(Buffer.from("plain text")), undefined);
  assert.equal(sniffImage(Buffer.alloc(0)), undefined);
});

test("binary and invalid UTF-8 are not text", () => {
  assert.equal(looksLikeText(Buffer.from("hello\nworld")), true);
  assert.equal(looksLikeText(Buffer.from("h\u00e9llo \u4f60\u597d")), true, "valid multi-byte UTF-8 is text");
  assert.equal(looksLikeText(Buffer.from([0x68, 0x00, 0x69])), false, "a NUL byte means binary");
  assert.equal(looksLikeText(Buffer.from([0xff, 0xfe, 0xfd])), false, "invalid UTF-8 is not text");
  assert.equal(looksLikeText(PNG), false, "an image is not text even though it decodes");
});

test("an image handed back for a text target becomes an image, never gibberish", async () => {
  // Regression: `wl-paste --no-newline` without --type returned the raw PNG for
  // an image-only clipboard, and the bytes were inserted into the prompt as text.
  const h = harness((command, args) =>
    command === "wl-paste" && args.includes("text/plain;charset=utf-8") ? PNG : undefined);
  const read = await h.read();
  assert.equal(read?.image?.mimeType, "image/png");
  assert.equal(read?.text, undefined);
  assert.equal(read?.image?.bytes.length, PNG.length);
});

test("the reader never asks for an untyped clipboard read", async () => {
  const h = harness(() => undefined);
  await h.read();
  assert.equal(
    h.calls.some(([, ...args]) => args.length === 1 && args[0] === "--no-newline"),
    false,
    "an untyped read can return image bytes",
  );
  assert.ok(h.calls.some(([, ...args]) => args.includes("text/plain;charset=utf-8")), "text is requested by type");
});

test("an image-only clipboard is still pasted as an image", async () => {
  const h = harness((command, args) =>
    command === "wl-paste" && args.includes("image/png") ? PNG : undefined);
  const read = await h.read();
  assert.equal(read?.image?.mimeType, "image/png");
});

test("text still wins when the clipboard offers both", async () => {
  const h = harness((command, args) => {
    if (command !== "wl-paste") return undefined;
    if (args.includes("text/plain;charset=utf-8")) return Buffer.from("real text");
    if (args.includes("image/png")) return PNG;
    return undefined;
  });
  const read = await h.read();
  assert.equal(read?.text, "real text");
  assert.equal(read?.image, undefined);
});
