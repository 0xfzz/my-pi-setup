# Clipboard paste on Linux

> Part of [pi-workflow-extensions](../README.md). Why paste works in one terminal and not another, and what this package adds.

## The two pastes

Pasting into the prompt is not one code path. It is two, and they fail
independently:

| What you press | Who reads the clipboard |
|---|---|
| `Ctrl+Shift+V` (kitty, GNOME Terminal, Konsole…), `prefix + ]` (tmux/Herdr), middle-click | **the terminal**, which sends the text as a bracketed paste (`ESC[200~ … ESC[201~`) |
| **`Ctrl+V`** — Pi's `app.clipboard.pasteImage` | **Pi**, by running a clipboard helper |
| right-click | Pi, same helper |

The first path never involves Pi, which is why pasting inside a multiplexer like
Herdr works even when Pi's own path is broken. The second is the one that
silently does nothing.

## Why Pi's own paste failed

Pi's reader (`dist/utils/clipboard.js`) had two gaps on Linux:

1. **`wl-paste` was gated on the environment.** It is only tried when
   `WAYLAND_DISPLAY` is exported. The socket is discoverable without it
   (`$XDG_RUNTIME_DIR/wayland-0`), so a Pi started from an X11-ish launcher, over
   ssh, from `systemd-run`, or from a terminal that did not inherit the variable
   never tried Wayland at all.
2. **`xclip` was asked for `STRING`.** Many toolkits only offer `UTF8_STRING` or
   `text/plain;charset=utf-8`, so `xclip -o` fails while the clipboard is
   perfectly readable.

Either way the read returns `null`, and `handleClipboardPaste` treats that as
"nothing to do": no text, no message, no error. That is the reported symptom —
"paste does nothing in kitty, works in Herdr".

On a machine with both displays the two clipboards can also hold different
content; this reader tries both, so the split stops being visible as a failure.

## What this package does

`extensions/clipboard-paste.ts` composes over the installed editor (it does not
replace another extension's editor), claims the same paste action and inserts
through the reader in `lib/clipboard.ts`:

| Order | Backend | Notes |
|---|---|---|
| 1 | `termux-clipboard-get` | Android/Termux |
| 2 | `wl-paste` | `WAYLAND_DISPLAY`, or the socket discovered in `$XDG_RUNTIME_DIR` |
| 3 | `xclip` | explicit `text/uri-list`, `UTF8_STRING`, `text/plain;charset=utf-8`, then `STRING` |
| 4 | `xsel` | when `xclip` is not installed |
| 5 | `tmux save-buffer -` | the buffer `prefix + ]` would paste; tried last because it is often stale |
| 6 | `readClipboardImage` | `image/png`, `image/jpeg`, `image/webp`, `image/gif` when no text is present |
| — | Pi's own reader | macOS and Windows: unchanged, including Finder file copies |

Ordering inside a backend matters: file paths (`text/uri-list`) win over images,
and images win over text, because a path is what the model can act on.

Pasted text is delivered as a bracketed paste rather than inserted literally, so
Pi keeps its own paste behaviour: a paste over 10 lines (or 1000 characters) is
stored and collapsed into a chip — `[paste #1 +40 lines]` — instead of flooding
the editor, and pi-paster can still turn image paths into `[#image 1]`.
`lib/paste-marker.ts` paints both chip shapes with the theme background
(`customMessageBg`), so they read as objects rather than as text the model was
asked to look at. Widths are unchanged, so the layout cannot shift.

`/paste-doctor` prints what the reader sees, which is the fastest way to tell a
missing helper from an empty clipboard:

```text
platform: linux
WAYLAND_DISPLAY=wayland-0 DISPLAY=:0 TMUX=no
clipboard: text "Pertama Check hex dari foto…"
tried: wl-paste --no-newline --type text/uri-list | wl-paste --no-newline …
```

When nothing is readable, the extension **says so** instead of doing nothing:

```text
Clipboard: nothing readable. Tried: wl-paste --no-newline, xclip -selection clipboard -out.
Install wl-clipboard or xclip, or paste with Ctrl+Shift+V (your terminal's own paste).
```

## Fixes outside this package

- `export WAYLAND_DISPLAY=wayland-0`, or `linux_display_server wayland` in
  `kitty.conf`, keeps every helper on the same clipboard.
- `wl-clipboard-x11` (or `wl-clip-persist`) bridges the Wayland and X11
  clipboards so X11-only apps see the same content.
- `Ctrl+Shift+V` remains the zero-dependency path: it is the terminal's own
  paste and works even when no helper is installed.

## Limits

- Reading the clipboard requires a helper: `wl-clipboard` on Wayland, `xclip` or
  `xsel` on X11. The extension reports which ones it tried, so a missing package
  is visible rather than mysterious.
- OSC 52 is a **write** channel for most terminals (and kitty only reads it with
  explicit grants), so it is not used for pasting.
- Wayland blocks clipboard reads for unfocused surfaces; a paste from a surface
  that lost focus can be empty even when the clipboard has content.
- Images are pasted as a temporary file path; the file lives in the OS temp
  directory and is not cleaned up by this extension.

## Verification

`tests/paste-marker.test.ts` covers chip detection, painting around existing
ANSI, and the width invariant. `tests/clipboard-reader.test.ts` covers backend order, socket discovery,
explicit X11 targets, URI-list parsing, image-only clipboards, helper failures
and the platform guard. `tests/clipboard-paste.test.ts` covers insertion of
text, file paths and images, the warning on an empty clipboard, a reader that
throws, and the macOS/Windows delegation path.
