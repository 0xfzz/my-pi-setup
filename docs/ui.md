# Popup design system

> Part of [pi-workflow-extensions](../README.md). The shared frame, list, markdown viewer, ask popup and responsive rules used by every extension dialog.

The implementation lives in `lib/popup.ts` (low-level frame and markdown) and
`lib/ui/` (shell, list, ask popup, tokens). New popups should use these
primitives instead of hand-rolling rows, scrolling or hints.

## Rules

1. **Always scroll.** A body that exceeds the viewport scrolls with `↑↓`/`jk`,
   `PgUp`/`PgDn`, `Home`/`End`, `g`/`G` and the mouse wheel. The frame, title,
   key hint and any sticky header/footer stay in place.
2. **Respect the terminal.** Height comes from `tui.terminal.rows` (never a
   literal `rows: 20`), and width comes from `popupOverlayOptions`. A popup
   never renders taller than the terminal or wider than the frame.
3. **One vocabulary.** `Esc close`/`Esc cancel`, `Enter select`/`Enter open`,
   `↑↓ scroll`, `type to filter`, `n/N next/prev`, `o nvim`. Hints belong in the
   frame, not repeated inside the body.
4. **One theme.** Colors come from the host theme tokens (`accent`, `border`,
   `dim`, `muted`, `danger`, `success`, `warning`, `userMessageBg`). No raw ANSI
   colors in callers.
5. **Narrow terminals degrade, never corrupt.** Below
   `POPUP_MIN_FRAMED_WIDTH` the frame becomes horizontal rules and the body
   still wraps at the terminal width.
6. **Cancellation is unanswered.** Closing a popup with `Esc`/`Ctrl+C` must not
   be converted into an inferred answer.

## Primitives

| Primitive | Use |
| --- | --- |
| `popupFrame` / `PopupPanel` | Tiny fixed-row menus and compatibility callers. |
| `PopupShell` (`lib/ui/shell.ts`) | Header + scrollable body + footer detail views. |
| `PopupList` | Pickers: virtualization, selection, digits, click, empty state. |
| `MarkdownPopup` / `renderMarkdown` | Markdown detail with `/` search, match highlighting, OSC 8 repair and code highlighting from the host theme. |
| `AskUserPopup` (`lib/ui/ask.ts`) | `ask_user` recommended marker, free-text row, scrolling and abort handling. |

`popupOverlayOptions(width, minWidth, maxHeight)` remains the standard geometry.
`popupBodyRows(terminalRows, desired)` computes a safe body budget.

## Keys

| Key | Action |
| --- | --- |
| `Esc` / `Ctrl+C` | Close or cancel (never answer) |
| `Enter` | Select / open |
| `↑↓` / `jk` | Move selection or scroll one line |
| `PgUp` / `PgDn` | Page |
| `Home` / `End` / `g` / `G` | First / last |
| `1`–`9` | Jump to a numbered picker row |
| `/` | Search in the markdown viewer |
| `n` / `N` | Next / previous search match |
| `o` / `v` | Open the artifact in `$PI_EDITOR`/`$VISUAL`/`$EDITOR` |

## Fallbacks

- TUI: `ctx.ui.custom` overlay.
- RPC/print or a host without `ui.custom`: native `select`/`input`/`confirm`.
  Labels and ordering stay the same; the custom-only free-text row is replaced
  by `ui.input`.
- Herdr children: `ask_user` still forwards through `agent_ping`; no user UI is
  opened there.

## Prompt chrome

`extensions/prompt-ui.ts` (implementation in `lib/prompt-ui.ts`) moves the model
out of the footer and makes context usage readable at a glance:

```text
◆ deepseek-v4.1-flash · opencode-go · high        ← widget above the editor
~/project (main) • Session title
context [███████░░░░░░░░░] 27.5%  275k used · 725k left · 1.0M window
↑1.5k ↓300 R5.0k W500 CH72.7% $0.150
MCP: 1 server enabled
```

- The model badge is the `aboveEditor` widget `prompt-model`; it reads
  `ctx.model` and `ctx.thinkingLevel` live, so `/model` updates it without a
  reload.
- The footer is a custom `ContextFooter`. It reads `ctx.getContextUsage()` every
  frame (unknown usage renders `?`, not a fake percentage), colors the bar green
  → amber → red at 70% / 90%, and keeps the cumulative token/cost line plus
  extension statuses.
- Parent TUI sessions only; Herdr children and RPC/print keep Pi's default
  chrome. Removing the extension restores the built-in footer on shutdown.

## Verification

`tests/ui-shell.test.ts`, `tests/ask-popup.test.ts`, `tests/artifact-viewer.test.ts`
and `tests/selection-*.test.ts` cover frame integrity, scroll/reveal, paging,
mouse wheel, narrow fallback, markdown search, nvim save-back, recommended
answers, free text and table/quote/code/list selection at 24–120 columns.
