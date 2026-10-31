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
| `RouterSettingsPopup` (`lib/ui/router-settings.ts`) | Route editor: add models, set the routing method and trigger, order the chain. |
| `ProviderSettingsPopup` (`lib/ui/provider-settings.ts`) | Provider editor: a durable step wizard, per-provider models, accounts and deletion. |

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

`extensions/prompt-ui.ts` (implementation in `lib/prompt-ui.ts`) draws the model
into the prompt border and makes context usage readable at a glance:

```text
── deepseek-v4.1-flash · opencode-go · high ─────────────────
❯ 
──────────────────────────────────────────────────────────────
~/project (main) • Session title
ctx [██████░░░░░░] 27.5% · 275k/1.0M · 725k left · ↑1.5k ↓300 · $0.150
MCP: 1 server enabled
```

- The model label is embedded in the editor's own top rule by
  `attachModelBorder`, which patches the live editor's `renderTopBorder` instead
  of installing a fresh `CustomEditor`. The editor slot is single-occupancy
  (`pi-paster`, `prompt-history`, `modes` all use it), so the extension composes
  over whatever factory already owns the slot — replacing it silently disabled
  image paste and the mode switch key when `prompt-ui` loaded last. The patch
  reads `ctx.model` and `ctx.thinkingLevel` live, so `/model` and the thinking
  shortcut update it without a reload and without spending an extra row above
  the prompt. Long labels truncate with `…`; the `↑N` scroll indicator is
  preserved, and the rule keeps the thinking-level border color.
- The footer is a compact `ContextFooter`: one context line with the bar,
  percentage, used/window, remaining tokens, input/output totals and `$` cost,
  followed by extension statuses only when present. It reads
  `ctx.getContextUsage()` every frame (unknown usage renders `?`, not a fake
  percentage) and colors the bar green → amber → red at 70% / 90%.
- Parent TUI sessions only; Herdr children and RPC/print keep Pi's default
  chrome. Removing the extension restores the built-in editor and footer on
  shutdown.

## Verification

`tests/ui-shell.test.ts`, `tests/ask-popup.test.ts`, `tests/artifact-viewer.test.ts`
and `tests/selection-*.test.ts` cover frame integrity, scroll/reveal, paging,
mouse wheel, narrow fallback, markdown search, nvim save-back, recommended
answers, free text and table/quote/code/list selection at 24–120 columns.
