# Image thumbnails

> Part of [pi-workflow-extensions](../README.md). Display-only downscaling of the images Pi draws in the terminal.

| Field | Value |
| --- | --- |
| **Status** | current |
| **Scope** | `extensions/image-thumbnails.ts`, `lib/image-thumbnails.ts` |
| **Verified against** | `tests/image-thumbnails.test.ts` |

Pi re-sends an inline image's full base64 payload to the terminal on every render, so a
multi-megabyte screenshot makes scrolling and typing lag. This extension shows every
inline image (a pasted attachment preview from `pi-paster`, a screenshot or file read
returned by a tool) as a small thumbnail instead.

**Only the displayed copy changes.** Each pi-tui `Image` swaps its own private data for
a thumbnail the first time it renders. The attachment sent to the model, the file on
disk and the tool result content are never modified.

- A large image shows `[image · preparing preview…]` for a moment while Pi's Photon
  worker resizes it off the UI thread, then repaints. The same image is resized once
  (an LRU cache keyed by digest), so later renders have no placeholder frame.
- Images already under about 90 KB are shown unchanged.
- On Kitty-protocol terminals, which only accept PNG, the thumbnail is converted to PNG.
- If an image cannot be decoded, or the thumbnail is not smaller, the original is shown.
- Nothing happens when the terminal cannot draw inline images.

Optional `~/.pi/agent/image-thumbnails.json`:

```json
{ "enabled": true, "maxDimension": 640, "jpegQuality": 60, "maxBytes": 200000 }
```

Restart or `/reload` to apply changes. `maxDimension` is the longest side in pixels.
Disable the extension with `pi config`, or set `"enabled": false`.

Limits: the swap works by patching pi-tui's `Image.prototype.render`, so it affects
every image Pi draws, not only pasted ones. A Pi version that changes the `Image` fields
(`base64Data`, `mimeType`) would need this updated. On Kitty, a noisy image can still be
several hundred KB as a PNG thumbnail; lower `maxDimension` if that matters.
