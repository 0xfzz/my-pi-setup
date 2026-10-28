import assert from "node:assert/strict";
import { test } from "node:test";
import { insertClipboard, type PasteDeps } from "../extensions/clipboard-paste.ts";
import type { ClipboardRead } from "../lib/clipboard.ts";

function editor() {
  const inserted: string[] = [];
  return {
    inserted,
    insertTextAtCursor(text: string) { inserted.push(text); },
  };
}

function deps(read: ClipboardRead | undefined | Error, overrides: Partial<PasteDeps> = {}) {
  const notices: Array<{ message: string; level: string }> = [];
  const images: string[] = [];
  return {
    notices,
    images,
    deps: {
      platform: "linux" as const,
      read: async () => {
        if (read instanceof Error) throw read;
        return read;
      },
      notify: (message: string, level: "warning" | "info") => { notices.push({ message, level }); },
      writeImage: (image: NonNullable<ClipboardRead["image"]>) => {
        const path = `/tmp/clip.${image.mimeType.split("/")[1]}`;
        images.push(path);
        return path;
      },
      ...overrides,
    } satisfies PasteDeps,
  };
}

test("text is inserted at the cursor", async () => {
  const target = editor();
  const h = deps({ text: "multi\nline", attempts: [] });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(target.inserted, ["multi\nline"]);
  assert.deepEqual(h.notices, []);
});

test("copied files become newline-separated paths", async () => {
  const target = editor();
  const h = deps({ files: ["/a/one.txt", "/a/two.txt"], attempts: [] });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(target.inserted, ["/a/one.txt\n/a/two.txt"]);
});

test("an image is written to a temp file and its path inserted", async () => {
  const target = editor();
  const h = deps({ image: { bytes: Buffer.from("png"), mimeType: "image/png" }, attempts: [] });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(target.inserted, ["/tmp/clip.png"]);
  assert.deepEqual(h.images, ["/tmp/clip.png"]);
});

test("an empty clipboard warns and names the terminal's own paste", async () => {
  const target = editor();
  const h = deps({ attempts: ["wl-paste --no-newline", "xclip -selection clipboard -out"] });
  assert.equal(await insertClipboard(target, h.deps), "empty");
  assert.deepEqual(target.inserted, []);
  assert.equal(h.notices.length, 1);
  assert.equal(h.notices[0]?.level, "warning");
  assert.match(h.notices[0]!.message, /nothing readable/i);
  assert.match(h.notices[0]!.message, /Ctrl\+Shift\+V/);
});

test("a reader that throws is treated as an empty clipboard, not a crash", async () => {
  const target = editor();
  const h = deps(new Error("spawn failed"));
  assert.equal(await insertClipboard(target, h.deps), "empty");
  assert.equal(h.notices.length, 1);
});

test("non-Linux platforms delegate to pi without notifying", async () => {
  const target = editor();
  const h = deps({ text: "ignored", attempts: [] }, { platform: "darwin" });
  assert.equal(await insertClipboard(target, h.deps), "delegated");
  assert.deepEqual(target.inserted, []);
  assert.deepEqual(h.notices, [], "macOS keeps pi's Finder-aware paste; no warning");
});

test("an editor without insertTextAtCursor falls back to insertText", async () => {
  const inserted: string[] = [];
  const target = { insertText: (text: string) => inserted.push(text) };
  const h = deps({ text: "hello", attempts: [] });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(inserted, ["hello"]);
});

test("pasted text is delivered through the editor's paste path, not inserted literally", async () => {
  // Regression: a literal insert bypasses the editor's paste handling, so a
  // 400-line paste never collapsed into the `[paste #N +lines]` marker.
  const target = editor();
  const delivered: string[] = [];
  const h = deps({ text: "line\n" + "x\n".repeat(40), attempts: [] }, {
    pasteText: (text: string) => delivered.push(text),
  });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(target.inserted, [], "nothing is inserted behind the editor's back");
  assert.equal(delivered.length, 1);
  assert.match(delivered[0]!, /^line/);
});

test("image paths are pasted through the editor too, so pi-paster can claim them", async () => {
  const target = editor();
  const delivered: string[] = [];
  const h = deps({ image: { bytes: Buffer.from("png"), mimeType: "image/png" }, attempts: [] }, {
    pasteText: (text: string) => delivered.push(text),
  });
  assert.equal(await insertClipboard(target, h.deps), "pasted");
  assert.deepEqual(delivered, ["/tmp/clip.png"]);
  assert.deepEqual(target.inserted, []);
});

test("Ctrl+Shift+V and Shift+Insert are paste keys, not dead keys", async () => {
  const { isPasteKey } = await import("../extensions/clipboard-paste.ts");
  const { setKittyProtocolActive } = await import("@earendil-works/pi-tui");
  setKittyProtocolActive(true);
  // Under the kitty keyboard protocol these are distinct sequences; only
  // Ctrl+V was bound, so the classic paste shortcut arrived as an unbound key.
  assert.equal(isPasteKey("\x1b[118;5u"), true, "kitty Ctrl+V");
  assert.equal(isPasteKey("\x1b[118;6u"), true, "kitty Ctrl+Shift+V");
  assert.equal(isPasteKey("\x16"), true, "legacy Ctrl+V");
  assert.equal(isPasteKey("\x1b[2;2~"), true, "Shift+Insert");
  assert.equal(isPasteKey("v"), false, "a plain letter is not a paste");
  assert.equal(isPasteKey("\x1b[118;4u"), false, "Ctrl+Alt+V is not a paste");
  assert.equal(isPasteKey("\x1b[200~text\x1b[201~"), false, "an actual terminal paste must reach the editor");

  const remapped = { matches: (data: string, action: string) => action === "app.clipboard.pasteImage" && data === "\x1b[19;5u" };
  assert.equal(isPasteKey("\x1b[19;5u", remapped as never), true, "a user rebind still works");
  setKittyProtocolActive(false);
});
