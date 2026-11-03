# Sidebar and pickers

> Part of [pi-workflow-extensions](../README.md). The right rail, the `Alt+W` prefix menu, and the detail popups.

The main terminal gets a resizable right rail (**24 columns by default**) with just three sections:

```text
│ ◇ Normal
│ AI chat & tools
│ Alt+M · switch
│
│ Todo 1/3
│ ☑ Inspect existing UI
│ ● Build minimal sidebar
│   with readable wrapping
│ ☐ Verify resizing
│ /workflow-todos
│
│ Artifacts 1
│ · Sidebar design
│ /artifacts
```

- Shows up to three todo rows in **natural plan order** with clean unicode checked (`☑`), in-progress (`●`), and unchecked (`☐`) status glyphs (no prepended numbers). Long todo text wraps with readable hanging continuation indentation so tasks can be read carefully without truncation. Full lists and viewers remain under `/workflow-todos` and `/artifacts`; the rail does not steal editor focus.
- Replaces the todo/artifact/mode widgets rather than duplicating them. No extra model, prompt injection, files, timers, or polling. Provider state updates through Pi's local event bus.
- Below **100 terminal columns**, the rail collapses to **one compact status line** above the editor. Short terminals show fewer rows. `/sidebar` toggles it; `/sidebar on` and `/sidebar off` are explicit. Off restores full chat width without bringing back clutter. The toggle lasts for this Pi process.
- **Pluggable ASCII animations & Rust WebAssembly engine:** when spare vertical rows exist below the sidebar sections in fullscreen, an animated ASCII piece runs at its preferred frame rate without taking editor focus.
  - **Pluggable architecture (`lib/sidebar-animation.ts`):** Includes three built-in pieces:
    - **`aquarium`**: Swimming neon tetras, golden minnows, angelfish, pulsating jellyfish, red crabs on gravel, swaying kelp, and rising bubbles.
    - **`cats`**: Slow-paced autonomous cat playground with multiple scenes (laser chase, cardboard box sits, yarn acrobatics, fish snack feasts, cozy afternoon naps, playful tumble scuffles, and top-shelf kitten) and smooth star-dither cross-fade transitions.
    - **`matrix`**: Cascading phosphorescent green digital code streams with bright leading heads.
    - **`fire`**: Cozy flickering campfire hearth with dancing flames and rising embers.
    - **`auto`** (aliases: `random`, `shuffle`, `gallery`): Autonomous playlist cycling through all pieces with slow-paced durations and seamless dither transitions.
  - **Controls:**
    - `/sidebar anim`: shows current and available animations.
    - `/sidebar anim <name>`: switches the active piece (e.g. `/sidebar anim cats`, `/sidebar anim auto`, `/sidebar anim matrix`, `/sidebar anim fire`, `/sidebar anim aquarium`).
    - `/sidebar anim on` / `/sidebar anim off`: toggles animation on or off. Backward-compatible alias `/sidebar aquarium on|off` remains supported.
  - **Custom plugins:** other extensions or scripts can register animations at runtime via `pi.events.emit("sidebar:register_animation", { id, name, render })`.
  - **Rust WebAssembly optimization (`crates/aquarium-engine`):** compiles to native WebAssembly (`wasm32-unknown-unknown`, outputting to `lib/aquarium_engine.wasm`). Generates frames in under **30 µs/frame (>33,000 FPS)** directly in linear memory with zero JS garbage collection overhead. Automatically falls back to pure TypeScript if WASM is unavailable.
- **Resize:** in fullscreen, drag the vertical `│` divider left/right. Mouse must be enabled in Pi and forwarded by your terminal/tmux. In either renderer, `/sidebar width 32` sets the width, `/sidebar width` reports it, and `/sidebar reset` returns to 24. Valid widths are **20–60 columns**, automatically clamped to leave at least **76 columns for chat**. Your preferred width returns when the terminal grows; below 100 columns the sidebar still collapses. Width updates are deduplicated by integer column bounds so high-frequency terminal mouse events do not trigger redundant TUI re-renders. Dragging owns only the divider, not transcript selection or editor focus.
- **Fullscreen selection**: drag selects text as before; double-click on a wrapped OSC 8 link selects the whole link, and triple-click selects the semantic markdown block under the pointer — one table cell (not the whole row), a table row when you click a border, a quote (without its `│ ` marker), a fenced code block (without the fences), a list item with its wrapped continuation lines, or a paragraph. Region isolation still clamps a selection to the sidebar, conversation or prompt box, and copying a multi-line table cell never includes a neighbouring column. In regular/scrollback mode the terminal emulator owns selection, so these app-side refinements apply to fullscreen only.
- **Fullscreen** keeps the host's original transcript ScrollView/editor layout. Pi exposes no public layout-root getter, so this adapter **feature-checks** the existing root field and `setLayoutRoot`, and additionally requires Pi **1.3.0 or newer** (a floor, not a pin: an equality check on `1.3.0` disabled the sidebar entirely on 1.4.0, where the layout API is unchanged). Unsupported fullscreen layouts retain the original widgets and show a warning. No installed Pi sources are patched.
- **Regular/scrollback mode** composes public TUI children, drawing the rail beside the latest visible screenful. Native terminal scrollback cannot keep it pinned while manually scrolling old terminal history. Resizing or toggling changes wrapping in either renderer.
- Main interactive UI only; child sessions and RPC/print runs keep their existing behavior. Disabling only `extensions/sidebar.ts` in `pi config` restores the independent widgets after reload.

Already registered in the installed package. **Restart Pi or run `/reload` when no children are running.** Existing sessions are not hot-reloaded automatically.

Verification: focused sidebar tests cover both renderers, two provider load orders, sidebar ownership/fallback, branch restoration, narrow layout, cursor preservation, toggles, ScrollView state, renderer switching, and cleanup. Aquarium tests verify 12–120 width scaling, border integrity, animation loop/clock pauses, row allocation, and command toggling. Resize tests also cover capture, screen-coordinate dragging, width limits, lost-release recovery, command validation/reset, and chat space on narrow terminals. Run `node --experimental-strip-types --test tests/sidebar*.test.ts`. Live tmux/Pi checks verified regular/fullscreen rendering, aquarium animation frames, 80-column collapse, reload, artifact picker/viewer, Alt+M, and shell output without inference. The full suite's existing filesystem milestone test needs available OS file watchers; an exhausted inotify quota produces `ENOSPC` independently of this sidebar.

## Cache section

`extensions/cache-stats.ts` adds a **Cache** section (between Account and Todo) that shows whether the last request was served from the provider's prompt cache: `last 94% hit · 18k read`, the session trend, and — on a large cold request — `miss: 15k new · 3.0k written` in the warning tone. It reads the usage each assistant message already carries, so it costs no requests. It stays hidden until a provider reports prompt tokens; a provider that never reports cache reads shows `provider reports no cache`. A plan that could not place a marker says so in a drift row (`breakpoint: no prompt`, `breakpoint: marker budget`), so a silent regression is visible rather than inferred from a low hit rate. The placement itself is `extensions/cache-breakpoints.ts`; this section only reports. See [token efficiency](token-efficiency.md).
